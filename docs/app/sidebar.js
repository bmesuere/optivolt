import { isSystemSettingsFetched } from "./storage.js";

export function setBadge(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

export function reorderSidebar({ isVrmConfigured, vrmSiteValue }) {
  const stack = document.getElementById("sidebar-stack");
  if (!stack) return;

  const vrmOK = isVrmConfigured();
  const sysFetched = isSystemSettingsFetched();

  let order = ["card-algo", "card-data", "card-system", "card-vrm"];
  if (!vrmOK) order = ["card-vrm", "card-algo", "card-data", "card-system"];
  if (vrmOK && !sysFetched) {
    const i = order.indexOf("card-system");
    if (i > -1) order.splice(i, 1);
    order.splice(1, 0, "card-system");
  }

  for (const id of order) {
    const node = document.getElementById(id);
    if (node) stack.appendChild(node);
  }

  setBadge("badge-vrm", vrmOK ? `Connected (site ${vrmSiteValue || "…"})` : "Not connected");
}
