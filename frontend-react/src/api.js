const API_ROOT = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");

export function getAuth() {
  try { return JSON.parse(sessionStorage.getItem("lems.auth") || "null"); }
  catch { return null; }
}
export function saveAuth(value) {
  if (value) sessionStorage.setItem("lems.auth", JSON.stringify(value));
  else sessionStorage.removeItem("lems.auth");
}
export async function request(path, options = {}) {
  const auth = getAuth();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (auth?.token) headers.set("Authorization", "Bearer " + auth.token);
  let response;
  try {
    response = await fetch(API_ROOT + "/" + String(path).replace(/^\/+/, ""), { ...options, headers });
  } catch {
    throw new Error("Cannot reach the LEMS server. Check your internet connection and API URL.");
  }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === "object" && data ? data.message || data.error : data;
    throw new Error(message || "Request failed (" + response.status + ").");
  }
  return data;
}
export const api = {
  login: data => request("login", { method: "POST", body: JSON.stringify(data) }),
  signup: data => request("signup", { method: "POST", body: JSON.stringify(data) }),
  equipment: () => request("equipment"),
  checkout: equipment_id => request("checkout", { method: "POST", body: JSON.stringify({ equipment_id }) }),
  returnEquipment: equipment_id => request("return", { method: "POST", body: JSON.stringify({ equipment_id }) }),
  transactions: (id, history = false) => request("transactions/user/" + encodeURIComponent(id) + (history ? "?history=true" : "")),
  allTransactions: () => request("transactions"),
  addEquipment: data => request("equipment", { method: "POST", body: JSON.stringify(data) }),
  updateEquipment: (id, data) => request("equipment/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(data) }),
  submitComplaint: (equipment_id, issue_description) => request("complaints", { method: "POST", body: JSON.stringify({ equipment_id, issue_description }) }),
  complaints: () => request("complaints"),
  resolveComplaint: (id, data) => request("complaints/" + encodeURIComponent(id) + "/resolve", { method: "PUT", body: JSON.stringify(data) }),
  findStudent: id => request("admin/student/" + encodeURIComponent(id)),
  forgotPassword: email => request("forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token, new_password) => request("reset-password", { method: "POST", body: JSON.stringify({ token, new_password }) })
};
