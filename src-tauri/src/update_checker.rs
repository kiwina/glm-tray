use serde::{Deserialize, Serialize};

const GITHUB_API_URL: &str = "https://api.github.com/repos/kiwina/glm-tray/releases/latest";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const UPDATER_JSON_URL: &str = "https://github.com/kiwina/glm-tray/releases/latest/download/updater.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
    pub release_notes: String,
    pub published_at: String,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: String,
    published_at: String,
}

#[derive(Debug, Deserialize)]
struct UpdaterJson {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

/// Check for updates with improved strategy:
/// 1. Check updater.json (Source of Truth for Auto-Update)
/// 2. Fallback to GitHub API (Informational)
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    // 1. Try updater.json first (Critical for functional Auto-Update)
    match check_updater_json().await {
        Ok(info) => return Ok(info),
        Err(e) => {
            log::warn!("updater.json check failed: {}. Trying fallbacks...", e);
        }
    }

    // 2. Try GitHub API
    match check_github_api().await {
        Ok(info) => return Ok(info),
        Err(e) => {
            log::warn!("GitHub API check failed: {}", e);
            return Err(e);
        }
    }
}

async fn create_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("glm-tray")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

async fn check_updater_json() -> Result<UpdateInfo, String> {
    let client = create_client().await?;
    log::info!("Checking for updates via updater.json...");

    let response = client
        .get(UPDATER_JSON_URL)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("updater.json returned status: {}", response.status()));
    }

    let updater_info: UpdaterJson = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse updater.json: {}", e))?;

    let latest_version = updater_info.version.trim_start_matches('v').to_string();
    let current_version = CURRENT_VERSION.to_string();
    let has_update = compare_versions(&latest_version, &current_version);

    if has_update {
        log::info!(
            "New version found (updater.json): {} (Current: {})",
            latest_version,
            current_version
        );
    } else {
        log::info!(
            "Up to date (updater.json): {} (Matches {})",
            current_version,
            latest_version
        );
    }

    let download_url = format!(
        "https://github.com/kiwina/glm-tray/releases/tag/v{}",
        latest_version
    );

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
        release_notes: updater_info
            .notes
            .unwrap_or_else(|| "Release notes available on GitHub.".to_string()),
        published_at: updater_info
            .pub_date
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        source: Some("updater.json".to_string()),
    })
}

async fn check_github_api() -> Result<UpdateInfo, String> {
    let client = create_client().await?;

    log::info!("Checking for updates via GitHub API...");

    let response = client
        .get(GITHUB_API_URL)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub API returned status: {}",
            response.status()
        ));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let current_version = CURRENT_VERSION.to_string();
    let has_update = compare_versions(&latest_version, &current_version);

    if has_update {
        log::info!(
            "New version found (API): {} (Current: {})",
            latest_version,
            current_version
        );
    } else {
        log::info!(
            "Up to date (API): {} (Matches {})",
            current_version,
            latest_version
        );
    }

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url: release.html_url,
        release_notes: release.body,
        published_at: release.published_at,
        source: Some("GitHub API".to_string()),
    })
}

/// Compare two semantic versions (e.g., "0.2.0" vs "0.1.0")
fn compare_versions(latest: &str, current: &str) -> bool {
    let parse_version = |v: &str| -> Vec<u32> {
        v.split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect()
    };

    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);

    for i in 0..latest_parts.len().max(current_parts.len()) {
        let latest_part = latest_parts.get(i).unwrap_or(&0);
        let current_part = current_parts.get(i).unwrap_or(&0);

        if latest_part > current_part {
            return true;
        } else if latest_part < current_part {
            return false;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_versions() {
        assert!(compare_versions("0.2.0", "0.1.0"));
        assert!(compare_versions("1.0.0", "0.1.0"));
        assert!(compare_versions("0.1.1", "0.1.0"));
        assert!(!compare_versions("0.1.0", "0.1.0"));
        assert!(!compare_versions("0.0.9", "0.1.0"));
    }
}
