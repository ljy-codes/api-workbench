//! Windows current-user DPAPI only: never fall back to plaintext or machine scope.

#[cfg(windows)]
mod windows {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    struct Output(CRYPT_INTEGER_BLOB);

    impl Drop for Output {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                // DPAPI allocates this buffer with LocalAlloc. Clear decrypted
                // bytes before releasing it, including on UTF-8 decoding failure.
                unsafe {
                    for i in 0..self.0.cbData as usize {
                        ptr::write_volatile(self.0.pbData.add(i), 0);
                    }
                    LocalFree(self.0.pbData.cast());
                }
            }
        }
    }

    pub(super) fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let length =
            u32::try_from(bytes.len()).map_err(|_| "DPAPI 输入过大，未保存敏感值".to_string())?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = Output(CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        });
        // No LOCAL_MACHINE flag, description, UI, or app-managed encryption key.
        // Input and output live for the entire FFI call. DPAPI does not modify input.
        let success = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            }
        };
        if success == 0 {
            return Err(if encrypt {
                "DPAPI 加密失败，未保存敏感值"
            } else {
                "DPAPI 解密失败，请使用原 Windows 用户或重新设置敏感值"
            }
            .to_string());
        }
        if output.0.cbData == 0 {
            return Ok(Vec::new());
        }
        if output.0.pbData.is_null() {
            return Err("DPAPI 返回无效数据".to_string());
        }
        Ok(unsafe { slice::from_raw_parts(output.0.pbData, output.0.cbData as usize) }.to_vec())
    }
}

pub(crate) fn protect(value: &str) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        windows::transform(value.as_bytes(), true)
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err("DPAPI 仅支持 Windows，禁止明文保存敏感值".to_string())
    }
}

pub(crate) fn unprotect(ciphertext: &[u8]) -> Result<String, String> {
    #[cfg(windows)]
    {
        let bytes = windows::transform(ciphertext, false)?;
        String::from_utf8(bytes).map_err(|error| {
            // Do not format FromUtf8Error: it contains the decrypted bytes.
            let mut invalid = error.into_bytes();
            for byte in &mut invalid {
                unsafe { std::ptr::write_volatile(byte, 0) };
            }
            "DPAPI 解密结果不是有效 UTF-8".to_string()
        })
    }
    #[cfg(not(windows))]
    {
        let _ = ciphertext;
        Err("DPAPI 仅支持 Windows，无法解密敏感值".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_empty_and_unicode_without_plaintext_ciphertext() {
        for value in ["", "Token-中文-secret-0123456789"] {
            let cipher = protect(value).unwrap();
            assert!(!cipher.is_empty());
            assert_ne!(cipher, value.as_bytes());
            assert_eq!(unprotect(&cipher).unwrap(), value);
        }
    }

    #[cfg(windows)]
    #[test]
    fn invalid_ciphertext_is_rejected_without_echoing_input() {
        let error = unprotect(b"private-sensitive-material").unwrap_err();
        assert!(error.contains("DPAPI"));
        assert!(!error.contains("private-sensitive-material"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_has_no_plaintext_fallback() {
        assert!(protect("secret").is_err());
        assert!(unprotect(b"secret").is_err());
    }
}
