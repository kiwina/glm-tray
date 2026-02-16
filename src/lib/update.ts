import { check as tauriCheck } from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import type { UpdateInfo } from "./types";
import { isTauriRuntime } from "./constants";
import { backendInvoke } from "./api";

export async function checkAndShowUpdate(): Promise<void> {
  if (!isTauriRuntime) return;

  try {
    const info = await backendInvoke<UpdateInfo>("check_for_updates_cmd");

    if (!info.has_update) {
      return;
    }

    showUpdateToast(info);
  } catch (err) {
    console.warn("Update check failed:", err);
  }
}

function showUpdateToast(info: UpdateInfo): void {
  const toast = document.getElementById("update-toast");
  const versionEl = document.getElementById("update-version");
  const progressEl = document.getElementById("update-progress");
  const readyEl = document.getElementById("update-ready");
  const actionsEl = document.getElementById("update-actions");
  const downloadBtn = document.getElementById("update-download");
  const laterBtn = document.getElementById("update-later");
  const restartBtn = document.getElementById("update-restart");
  const closeBtn = document.getElementById("update-close");

  if (!toast) return;

  // Set version text
  if (versionEl) versionEl.textContent = `v${info.latest_version}`;

  // Show toast
  toast.classList.remove("hidden");

  // Reset UI state
  if (progressEl) progressEl.classList.add("hidden");
  if (readyEl) readyEl.classList.add("hidden");
  if (actionsEl) actionsEl.classList.remove("hidden");

  // Use onclick to prevent listener stacking
  if (downloadBtn) {
    downloadBtn.onclick = async () => {
      await downloadAndInstallUpdate();
    };
  }

  if (laterBtn) {
    laterBtn.onclick = () => {
      hideUpdateToast();
    };
  }

  if (restartBtn) {
    restartBtn.onclick = async () => {
      try {
        await tauriRelaunch();
      } catch (err) {
        console.error("Relaunch failed:", err);
      }
    };
  }

  if (closeBtn) {
    closeBtn.onclick = () => {
      hideUpdateToast();
    };
  }
}

async function downloadAndInstallUpdate(): Promise<void> {
  const progressEl = document.getElementById("update-progress");
  const readyEl = document.getElementById("update-ready");
  const actionsEl = document.getElementById("update-actions");
  const percentEl = document.getElementById("update-percent");
  const progressBar = progressEl?.querySelector("progress");

  if (!progressEl || !actionsEl) return;

  actionsEl.classList.add("hidden");
  progressEl.classList.remove("hidden");

  try {
    const update = await tauriCheck();
    if (!update) {
      console.warn("Native updater returned null");
      actionsEl.classList.remove("hidden");
      progressEl.classList.add("hidden");
      return;
    }

    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength || 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0 && progressBar && percentEl) {
            const pct = Math.round((downloaded / contentLength) * 100);
            progressBar.value = pct;
            percentEl.textContent = String(pct);
          }
          break;
        case "Finished":
          break;
      }
    });

    // Show restart button
    progressEl.classList.add("hidden");
    if (readyEl) readyEl.classList.remove("hidden");
  } catch (err) {
    console.error("Update download failed:", err);
    actionsEl.classList.remove("hidden");
    progressEl.classList.add("hidden");
  }
}

export function hideUpdateToast(): void {
  const toast = document.getElementById("update-toast");
  if (toast) toast.classList.add("hidden");
}
