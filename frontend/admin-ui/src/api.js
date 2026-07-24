async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

export function fetchAdMagnetStudents(page, search = "") {
  const params = new URLSearchParams({ page });
  if (search) params.set("search", search);
  return getJSON(`/api/ad-magnet/students?${params.toString()}`);
}

export function fetchContacts(page, pageSize = 50) {
  return getJSON(`/api/contacts?limit=${pageSize}&page=${page}`);
}
