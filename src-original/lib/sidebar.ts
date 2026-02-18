import type { View } from "./types";
import { MAX_KEYS, NAV_BTN_CLS } from "./constants";
import { configState, currentView, latestRuntime } from "./state";
import { esc, dotClass } from "./helpers";
import { render } from "./views/render";

export function createSidebar(): void {
  const nav = document.getElementById("sidebar-nav") as HTMLDivElement;
  nav.innerHTML = "";

  const dashBtn = document.createElement("button");
  dashBtn.className = NAV_BTN_CLS;
  dashBtn.dataset.view = "dashboard";
  dashBtn.innerHTML = `
    <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
    <span class="text-[10px] font-medium tracking-wide">Home</span>`;
  dashBtn.addEventListener("click", () => {
    render("dashboard");
  });
  nav.appendChild(dashBtn);

  for (let i = 1; i <= MAX_KEYS; i++) {
    const btn = document.createElement("button");
    btn.className = NAV_BTN_CLS;
    btn.dataset.view = String(i);
    btn.addEventListener("click", () => {
      render(String(i) as View);
    });
    nav.appendChild(btn);
  }
}

export function updateSidebar(): void {
  document
    .querySelectorAll<HTMLButtonElement>("#sidebar-nav .nav-btn")
    .forEach((btn) => {
      const view = btn.dataset.view ?? "";
      btn.classList.toggle("active", view === currentView);

      if (view !== "dashboard") {
        const idx = Number(view);
        const slot = configState?.slots.find((s) => s.slot === idx);
        const rt = latestRuntime?.slots.find((s) => s.slot === idx);
        const hasContent = slot?.enabled || slot?.api_key || slot?.name;

        if (!hasContent) {
          btn.classList.add("hidden");
          return;
        }
        btn.classList.remove("hidden");

        const name = slot?.name || `Key ${idx}`;
        const dc = dotClass(slot, rt);
        const shortName =
          name.length > 8 ? name.slice(0, 7) + "\u2026" : name;

        btn.innerHTML = `
          <span class="nav-num relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border border-neutral transition-colors">
            ${idx}
            <span class="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full border-[1.5px] border-base-200 ${dc}"></span>
          </span>
          <span class="text-[10px] font-medium tracking-wide max-w-[68px] text-center truncate">${esc(shortName)}</span>`;
      }
    });
}
