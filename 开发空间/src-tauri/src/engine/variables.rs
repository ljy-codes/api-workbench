use crate::models::{Pair, ResolvedVariable, Workspace};
use std::collections::{BTreeMap, HashSet};

pub(super) const MASK: &str = "••••••";

struct Entry {
    value: String,
    source: &'static str,
    secret: bool,
}

pub(super) struct Variables(BTreeMap<String, Entry>);

/// Tokens reference the ORIGINAL template, never generated replacement text.
pub(super) enum Token<'a> {
    Literal(&'a str),
    Variable(&'a str),
}

pub(super) fn tokenize(template: &str) -> Result<Vec<Token<'_>>, String> {
    let mut tokens = Vec::new();
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        let literal = &remaining[..start];
        tokens.push(Token::Literal(literal));
        let after_open = &remaining[start + 2..];
        let end = after_open.find("}}").ok_or("变量占位符未闭合")?;
        let name = after_open[..end].trim();
        if name.is_empty() || name.contains(['{', '}']) || name.chars().any(char::is_control) {
            return Err("变量占位符名称无效".into());
        }
        tokens.push(Token::Variable(name));
        remaining = &after_open[end + 2..];
    }
    // A closing delimiter without an opening delimiter is ordinary text,
    // e.g. the last two braces of a nested JSON document in raw text mode.
    tokens.push(Token::Literal(remaining));
    Ok(tokens)
}

impl Variables {
    /// Auth references remain credentials even if the variable editor omitted
    /// isSecret. Never expose them through resolvedVariables or other templates.
    pub(super) fn protect(&mut self, template: &str) -> Result<(), String> {
        for token in tokenize(template)? {
            if let Token::Variable(name) = token {
                let entry = self
                    .0
                    .get_mut(name)
                    .ok_or("缺少模板引用的变量，请检查当前环境及变量作用域")?;
                entry.secret = true;
            }
        }
        Ok(())
    }

    pub(super) fn resolve(
        workspace: &Workspace,
        project: &str,
        service: &str,
        environment: &str,
        binding: &str,
        request: &str,
        temporary: &[Pair],
    ) -> Result<Self, String> {
        let mut values = Self(BTreeMap::new());
        for (scope, owner) in [
            ("project", project),
            ("service", service),
            ("environment", environment),
            ("binding", binding),
            ("request", request),
        ] {
            let mut names = HashSet::new();
            for variable in workspace
                .variables
                .iter()
                .filter(|v| v.project_id == project && v.scope == scope && v.owner_id == owner)
            {
                if variable.name.trim().is_empty() || !names.insert(&variable.name) {
                    return Err("同一作用域存在空名称或重复变量".into());
                }
                values.insert(&variable.name, &variable.value, scope, variable.is_secret);
            }
        }
        let mut names = HashSet::new();
        for pair in temporary.iter().filter(|p| p.enabled) {
            if pair.key.trim().is_empty() || !names.insert(&pair.key) {
                return Err("本次临时变量存在空名称或重复名称".into());
            }
            // Pair has no isSecret flag. An override cannot declassify an
            // existing secret variable merely by selecting a higher scope.
            values.insert(&pair.key, &pair.value, "temporary", false);
        }
        Ok(values)
    }

    fn insert(&mut self, name: &str, value: &str, source: &'static str, secret: bool) {
        let secret = secret || self.0.get(name).is_some_and(|previous| previous.secret);
        self.0.insert(
            name.into(),
            Entry {
                value: value.into(),
                source,
                secret,
            },
        );
    }

    pub(super) fn value(&self, name: &str, masked: bool) -> Result<&str, String> {
        let entry = self
            .0
            .get(name)
            .ok_or("缺少模板引用的变量，请检查当前环境及变量作用域")?;
        Ok(if masked && entry.secret {
            MASK
        } else {
            &entry.value
        })
    }

    pub(super) fn render(&self, template: &str, masked: bool) -> Result<String, String> {
        self.render_with_mask(template, masked.then_some(MASK))
    }

    pub(super) fn header_name(&self, template: &str, masked: bool) -> Result<String, String> {
        // Header names require ASCII. This placeholder is for validation only;
        // it is never sent or exposed as a decrypted secret.
        self.render_with_mask(template, masked.then_some("redacted"))
    }

    /// Internal identity only: never compare the shared display mask as a real
    /// header name. Preview snapshots may omit decrypted secret values, in
    /// which case distinct templates cannot safely be treated as equivalent.
    pub(super) fn header_identity(
        &self,
        template: &str,
        masked: bool,
    ) -> Result<Option<String>, String> {
        for token in tokenize(template)? {
            if let Token::Variable(name) = token {
                let entry = self
                    .0
                    .get(name)
                    .ok_or("缺少模板引用的变量，请检查当前环境及变量作用域")?;
                if masked && entry.secret && entry.value.is_empty() {
                    return Ok(None);
                }
            }
        }
        self.render(template, false).map(Some)
    }

    fn render_with_mask(&self, template: &str, mask: Option<&str>) -> Result<String, String> {
        let mut result = String::new();
        for token in tokenize(template)? {
            result.push_str(match token {
                Token::Literal(text) => text,
                Token::Variable(name) => {
                    let entry = self
                        .0
                        .get(name)
                        .ok_or("缺少模板引用的变量，请检查当前环境及变量作用域")?;
                    match mask {
                        Some(mask) if entry.secret => mask,
                        _ => &entry.value,
                    }
                }
            });
        }
        Ok(result)
    }

    pub(super) fn preview(&self) -> Vec<ResolvedVariable> {
        self.0
            .iter()
            .map(|(name, entry)| ResolvedVariable {
                name: name.clone(),
                value: if entry.secret {
                    MASK.into()
                } else {
                    entry.value.clone()
                },
                source: entry.source.into(),
                is_secret: entry.secret,
            })
            .collect()
    }
}
