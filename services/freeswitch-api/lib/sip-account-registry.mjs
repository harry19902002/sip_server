function registrationRows(body) {
  const parsed = JSON.parse(body || '{"row_count":0,"rows":[]}');
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function directoryRows(body) {
  const lines = String(body ?? "").split(/\r?\n/).filter((line) => line && line !== "+OK");
  const headers = lines.shift()?.split("|") ?? [];
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split("|")[index] ?? ""])));
}

function decodeXml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function directoryPasswords(body) {
  const passwords = new Map();
  for (const match of String(body ?? "").matchAll(/<user\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/user>/g)) {
    const password = match[2].match(/<param\s+name="password"\s+value="([^"]*)"/);
    if (password) passwords.set(decodeXml(match[1]), decodeXml(password[1]));
  }
  return passwords;
}

export function sipAccountRegistry(userBody, registrationBody, directoryBody = "", now = new Date()) {
  const registrations = new Map(registrationRows(registrationBody).map((item) => [String(item.reg_user ?? item.user ?? ""), item]));
  const passwords = directoryPasswords(directoryBody);
  const unique = new Map();
  for (const user of directoryRows(userBody)) {
    const account = String(user.userid ?? "").trim();
    const context = String(user.context ?? "").trim();
    const domain = String(user.domain ?? "").trim();
    if (!account || !context || !domain) continue;
    const key = `${account}@${domain}`;
    if (!unique.has(key)) unique.set(key, user);
  }

  const items = Array.from(unique.values()).map((user, index) => {
    const account = String(user.userid);
    const registration = registrations.get(account);
    const transport = registration ? String(registration.network_proto ?? "UDP").toUpperCase() : "—";
    return {
      id: index + 1,
      account,
      name: String(user.effective_caller_id_name || `Extension ${account}`),
      displayNumber: String(user.effective_caller_id_number || account),
      department: String(user.group || "未分配"),
      domain: String(user.domain),
      context: String(user.context),
      enabled: true,
      registration: registration ? "在线" : "未注册",
      lastRegistered: registration ? "当前已注册" : "无活动注册",
      transport,
      contact: registration ? String(registration.url ?? registration.contact ?? "") : String(user.contact ?? ""),
      password: passwords.get(account) ?? "",
    };
  });
  return { items, count: items.length, updatedAt: now.toISOString() };
}
