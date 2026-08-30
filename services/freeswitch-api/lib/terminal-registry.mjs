function parseRows(body) {
  const parsed = JSON.parse(body || '{"row_count":0,"rows":[]}');
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function activeExtensions(channelRows) {
  const active = new Set();
  for (const channel of channelRows) {
    for (const key of ["presence_id", "dest", "cid_num", "callee_num", "initial_dest"]) {
      const value = String(channel[key] ?? "").trim();
      if (value) active.add(value.split("@")[0]);
    }
    const match = String(channel.name ?? "").match(/sofia\/internal\/([^@/]+)/);
    if (match) active.add(match[1]);
  }
  return active;
}

export function terminalRegistry(registrationBody, channelBody, names = {}, zones = {}, now = new Date()) {
  const channels = activeExtensions(parseRows(channelBody));
  const items = parseRows(registrationBody).map((registration) => {
    const extension = String(registration.reg_user ?? registration.user ?? "").trim();
    const realm = String(registration.realm ?? "").trim();
    const ip = String(registration.network_ip ?? registration.ip ?? "").trim();
    const port = String(registration.network_port ?? registration.port ?? "").trim();
    const transport = String(registration.network_proto ?? registration.proto ?? "UDP").toUpperCase();
    const id = realm ? `${extension}@${realm}` : extension;
    return {
      id,
      name: names[id] || `SIP ${extension}`,
      extension,
      zone: zones[id] || "未分配",
      location: [ip, port].filter(Boolean).join(":"),
      ip,
      port,
      transport,
      contact: String(registration.url ?? registration.contact ?? ""),
      type: "SIP 终端",
      status: channels.has(extension) ? "播放中" : "在线空闲",
      last: "当前已注册",
      capability: "广播",
      priority: channels.has(extension) ? 0 : 1,
    };
  }).filter((item) => item.extension);
  return { items, count: items.length, updatedAt: now.toISOString() };
}
