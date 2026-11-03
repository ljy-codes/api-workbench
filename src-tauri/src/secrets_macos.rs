//! A random installation key stays in the login Keychain; SQLite holds only
//! versioned AES-256-GCM ciphertext with an independent random nonce per value.
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use security_framework::passwords::{generic_password, set_generic_password, PasswordOptions};
use std::sync::Mutex;
use zeroize::Zeroizing;

// Native tests use their own Keychain item, separate from the app's data key.
const SERVICE: &str = if cfg!(test) {
    "local.apiworkbench.desktop.tests"
} else {
    "local.apiworkbench.desktop"
};
const ACCOUNT: &str = "workspace-encryption-key-v1";
const MAGIC: &[u8] = b"EnvDock-mac-v1\0";
static KEY_LOCK: Mutex<()> = Mutex::new(());

fn key(create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let _guard = KEY_LOCK.lock().map_err(|_| "钥匙串访问失败")?;
    match generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT)) {
        Ok(bytes) if bytes.len() == 32 => Ok(Zeroizing::new(bytes)),
        Ok(_) => Err("钥匙串加密密钥无效，未保存敏感值".into()),
        Err(error) if error.code() == -25300 && create => {
            let mut bytes = Zeroizing::new(vec![0; 32]);
            OsRng.fill_bytes(&mut bytes);
            set_generic_password(SERVICE, ACCOUNT, &bytes)
                .map_err(|_| "无法保存钥匙串密钥，未保存敏感值")?;
            Ok(bytes)
        }
        Err(_) => Err("无法读取钥匙串密钥，请解锁登录钥匙串；旧密文需原 Mac 用户密钥".into()),
    }
}

fn encrypt(value: &str, key: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "加密密钥无效")?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|_| "敏感值加密失败")?;
    let mut result = MAGIC.to_vec();
    result.extend_from_slice(&nonce);
    result.extend(encrypted);
    Ok(result)
}

fn decrypt(bytes: &[u8], key: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(MAGIC) || bytes.len() < MAGIC.len() + 12 + 16 {
        return Err("不支持的敏感值格式；Windows DPAPI 数据需重新输入".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "加密密钥无效")?;
    let offset = MAGIC.len();
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&bytes[offset..offset + 12]),
                &bytes[offset + 12..],
            )
            .map_err(|_| "敏感值解密失败，密钥不匹配或数据损坏")?,
    );
    std::str::from_utf8(&plaintext)
        .map(str::to_owned)
        .map_err(|_| "敏感值编码无效".into())
}

pub(super) fn protect(value: &str) -> Result<Vec<u8>, String> {
    encrypt(value, &key(true)?)
}

pub(super) fn unprotect(bytes: &[u8]) -> Result<String, String> {
    // Reject foreign/corrupt records before asking for Keychain access.
    if !bytes.starts_with(MAGIC) || bytes.len() < MAGIC.len() + 28 {
        return Err("不支持的敏感值格式；Windows DPAPI 数据需重新输入".into());
    }
    decrypt(bytes, &key(false)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_randomization_and_tamper_detection() {
        let key = [42; 32];
        for value in ["", "Token-中文-secret-0123456789"] {
            let mut bytes = encrypt(value, &key).unwrap();
            assert_eq!(decrypt(&bytes, &key).unwrap(), value);
            assert_ne!(bytes, encrypt(value, &key).unwrap());
            assert!(decrypt(&bytes, &[43; 32]).is_err());
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
            assert!(decrypt(&bytes, &key).is_err());
        }
        for invalid in [b"private-sensitive-material".as_slice(), MAGIC] {
            assert!(decrypt(invalid, &key).is_err());
        }
    }

    #[test]
    #[ignore = "requires login Keychain access; run explicitly on macOS"]
    fn login_keychain_roundtrip() {
        let value = "EnvDock Keychain 验证";
        assert_eq!(unprotect(&protect(value).unwrap()).unwrap(), value);
    }
}
