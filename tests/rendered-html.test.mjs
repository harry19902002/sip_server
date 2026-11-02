import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SIP broadcast management platform", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>SIP广播系统 · 管理平台<\/title>/i);
  assert.match(html, /正在验证登录状态/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);
});

test("keeps core management surfaces in the application source", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function Overview\(/);
  assert.match(page, /function Realtime\(/);
  assert.match(page, /function Schedule\(/);
  assert.match(page, /function Terminals\(/);
  assert.match(page, /function SipAccounts\(/);
  assert.match(page, /function CodecSettings\(/);
  assert.match(page, /亮色风格/);
  assert.match(page, /暗色风格/);
  assert.match(page, /onThemeChange/);
  assert.match(page, /\/system\/codecs/);
  assert.match(layout, /title:\s*"SIP广播系统 · 管理平台"/);
  assert.match(packageJson, /"name": "sip-broadcast-system"/);
});

test("media library upload input accepts multiple files", async () => {
  // 回归测试：上传控件曾漏写 multiple，且 onChange 只取 files[0]，
  // 导致用户一次只能传一个音频，批量导入必须反复点击。
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const ts = (await import("typescript")).default;
  const source = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // 找到 type="file" 的 input，按用途分别校验：
  //   - 音频上传：必须支持多选（用户曾反馈只能单选）
  //   - 备份导入：单文件是合理设计（一个 ZIP），不要求 multiple
  // 用 accept 属性区分用途，避免「一刀切」把新增的备份输入误判为回归。
  const inputs = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === "input") {
        const attrs = node.attributes.properties;
        const attrOf = (name) => attrs.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === name);
        const typeAttr = attrOf("type");
        if (typeAttr?.initializer?.getText(source) === '"file"') {
          inputs.push({
            hasMultiple: Boolean(attrOf("multiple")),
            accept: attrOf("accept")?.initializer?.getText(source) ?? "",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.ok(inputs.length > 0, "应存在文件上传输入框");
  const audioInputs = inputs.filter((input) => /wav|mp3|audio/i.test(input.accept));
  assert.ok(audioInputs.length > 0, "应存在音频上传输入框");
  for (const input of audioInputs) {
    assert.equal(input.hasMultiple, true, '音频上传输入框必须带 multiple，否则无法多选音频');
  }

  // onChange 必须把整个 FileList 交给 upload，而不是只取第一个文件
  assert.match(page, /onChange=\{[^}]*upload\([^)]*\.files\)/, "onChange 应把完整 FileList 传给 upload");
  assert.doesNotMatch(page, /upload\(event\.target\.files\?\.\[0\]\)/, "不应只上传选中的第一个文件");
});

test("shortcuts is the sidebar entry point and the default home page", async () => {
  // 快捷入口是导航里的独立页面，并且是用户的默认首页（排在工作台第一位）。
  // 关键约束：
  //   1. PageKey 与 navGroups 都要有 shortcuts，否则点了菜单出不来；
  //   2. 必须真的注册到渲染分支，否则会落到 PlaceholderPage 占位页；
  //   3. 可选页面取自 navGroups 且排除 shortcuts 自身（避免「快捷入口的快捷入口」）；
  //   4. 必须排在工作台分组首位，且默认 page 为 shortcuts（登录后即进入）；
  //   5. 运行总览里不应再内嵌快捷入口区块；
  //   6. 图标要足够大（≥48px），否则页面显得空。
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /\|\s*"shortcuts"/, "PageKey 应包含 shortcuts");
  assert.match(page, /\{ key: "shortcuts", label: "快捷入口"/, "左侧导航应有快捷入口项");
  assert.match(page, /\{page === "shortcuts" && <Shortcuts/, "应渲染 Shortcuts 组件");
  assert.match(page, /function Shortcuts\(/, "应定义 Shortcuts 组件");

  // 排在工作台分组的第一位：先出现 shortcuts，再出现 overview
  const workbench = page.slice(page.indexOf('label: "工作台"'), page.indexOf('label: "广播业务"'));
  assert.ok(workbench.indexOf('"shortcuts"') < workbench.indexOf('"overview"'), "快捷入口应排在运行总览之前");

  // 默认首页 = shortcuts（登录后 / 退出后都回到这里）
  assert.match(page, /useState<PageKey>\("shortcuts"\)/, "默认页面应为快捷入口");
  assert.match(page, /setPage\("shortcuts"\)/, "登录/退出后应回到快捷入口");

  // 可选目录来自导航，并排除自身
  assert.match(page, /const shortcutCatalog: ShortcutItem\[\] = navGroups[\s\S]{0,160}\.filter\(\(item\) => item\.key !== "shortcuts"\)/, "可选页面应排除快捷入口自身");

  // 运行总览里不应再有快捷入口逻辑
  assert.doesNotMatch(page, /className="shortcut-bar"/, "不应再有内嵌的快捷入口区块");
  const overviewStart = page.indexOf("function Overview(");
  const overviewEnd = page.indexOf("\nfunction ", overviewStart + 1);
  assert.ok(overviewStart > 0 && overviewEnd > overviewStart, "应能定位 Overview 函数体");
  assert.doesNotMatch(page.slice(overviewStart, overviewEnd), /shortcut/i, "Overview 组件不应包含快捷入口逻辑");

  assert.match(page, /const MAX_SHORTCUTS = \d+/, "应有数量上限");
  assert.match(page, /localStorage/, "配置应持久化到本地");
  assert.match(page, /onClick=\{\(\) => go\(key\)\}/, "快捷卡片应能跳转页面");

  // 图标尺寸：大图标是这次改版的核心诉求之一
  const iconRule = css.match(/\.shortcut-tile-icon \{[^}]*width: (\d+)px/);
  assert.ok(iconRule, "应定义快捷入口图标尺寸");
  assert.ok(Number(iconRule[1]) >= 48, `图标应足够大（当前 ${iconRule[1]}px，要求 ≥48px）`);

  // 顶部概览条让首页有信息量，而不是只有按钮
  assert.match(page, /className="shortcut-summary"/, "应有顶部概览条");

  const catalog = page.match(/const DEFAULT_SHORTCUTS: PageKey\[\] = \[([^\]]+)\]/);
  assert.ok(catalog, "应定义默认快捷入口");
  assert.ok(catalog[1].split(",").length > 0, "默认快捷入口不能为空");
});

test("system config splits long content into tabs without unmounting panels", async () => {
  // 系统配置内容多，按主题切标签页。关键设计：
  // 面板用 hidden 控制可见性，而不是条件渲染 —— 否则切走再切回，
  // CodecSettings 里未保存的编码顺序草稿会被重置。
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // 标签常量定义在 SystemConfig 之前，因此切片要从常量处开始
  const configStart = page.indexOf("const CONFIG_TABS");
  const configEnd = page.indexOf("function CodecSettings(");
  assert.ok(configStart > 0 && configEnd > configStart, "应能定位系统配置区块");
  const config = page.slice(configStart, configEnd);

  // 至少 3 个分区，且覆盖基础/编码/运行
  const labels = [...config.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 3, `应有至少 3 个分区，实际 ${labels.length}`);
  for (const expected of ["基础设置", "编码格式", "运行状态"]) {
    assert.ok(labels.includes(expected), `缺少分区「${expected}」`);
  }

  // 无障碍：标签与面板正确关联
  assert.match(config, /role="tablist"/, "应有 tablist");
  assert.match(config, /role="tab"/, "应有 tab");
  assert.match(config, /role="tabpanel"/, "应有 tabpanel");
  assert.match(config, /aria-controls=\{`config-panel-\$\{tab\.key\}`\}/, "tab 应关联到 panel");

  // 核心：用 hidden 而非条件渲染
  assert.match(config, /hidden=\{activeTab !== "basic"\}/, "面板应用 hidden 控制");
  assert.match(config, /hidden=\{activeTab !== "codec"\}/, "编码面板应用 hidden 控制");
  assert.doesNotMatch(config, /\{activeTab === "\w+" && <section/, "不应用条件短路渲染面板");
  assert.match(config, /<CodecSettings role=\{role\} notify=\{notify\} onDirtyChange=\{setCodecDirty\} \/>/, "CodecSettings 应无条件挂载");

  // 未保存状态要能跨标签提示
  assert.match(config, /config-tab-dot/, "标签上应有未保存圆点");
  assert.match(page, /useEffect\(\(\) => \{ onDirtyChange\?\.\(dirty\); \}/, "编码页应把脏状态上报给父组件");
});

test("system config exposes guarded backup, restore and factory reset", async () => {
  // 备份/导入/重置都是破坏性操作，界面必须做足保护：
  //   1. 仅管理员可触发（非管理员按钮禁用 + 只读说明）；
  //   2. 导入需要二次确认（先选文件、提示覆盖数量、再确认）；
  //   3. 重置需要手工输入 RESET；
  //   4. 重置会重建用户表 → 必须提示重新登录，否则用户会看到一堆 401。
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const backupStart = page.indexOf("function BackupSettings(");
  assert.ok(backupStart > 0, "应定义 BackupSettings 组件");
  const backupEnd = page.indexOf("\nfunction ", backupStart + 1);
  const comp = page.slice(backupStart, backupEnd);

  // 三个功能区都在
  for (const section of ["导出当前配置", "导入备份包", "恢复出厂设置"]) {
    assert.ok(comp.includes(section), `缺少「${section}」区块`);
  }

  // 权限：非管理员禁用
  assert.match(comp, /const editable = role === "系统管理员"/, "应按角色判断可编辑");
  assert.match(comp, /disabled=\{!editable/, "非管理员应禁用操作按钮");
  assert.match(comp, /backup-readonly/, "非管理员应看到只读说明");

  // 导入二次确认
  assert.match(comp, /setPendingFile/, "选文件后应先进入待确认状态");
  assert.match(comp, /confirmRestore/, "应有确认导入的处理函数");
  assert.ok(comp.includes("确认覆盖并导入"), "应要求显式确认覆盖");

  // 重置：输入 RESET 才能提交，且后端也校验
  assert.match(comp, /resetText !== "RESET"/, "重置按钮应以输入 RESET 为启用条件");
  assert.match(comp, /confirm: "RESET"/, "提交时应带确认串");
  const server = await readFile(new URL("../services/freeswitch-api/server.mjs", import.meta.url), "utf8");
  assert.match(server, /system\/reset/, "后端应有重置接口");
  assert.match(server, /confirmation_required/, "后端应校验确认串");
  assert.match(server, /requiresRelogin: true/, "重置后应告知需要重新登录");

  // 导出走二进制下载
  assert.match(comp, /URL\.createObjectURL/, "导出应使用 blob 下载");

  // 标签页接入
  assert.match(page, /key: "backup", label: "备份与还原"/, "应有备份标签");
  assert.match(page, /config-panel-backup/, "应注册备份面板");
  assert.match(page, /<BackupSettings role=\{role\}/, "应挂载 BackupSettings");
});

test("no component reads a const before it is declared", async () => {
  // 回归测试：曾出现 Realtime 里 `playModeLabel` 在 `playMode` state 声明之前计算：
  //   const playModeLabel = playModeOptions.find((o) => o.key === playMode)?.label
  // 引用发生在回调内，TypeScript 的"先用后声明"检查不报错，但 `.find` 在渲染时
  // 同步执行 → TDZ（Cannot access 'playMode' before initialization）→ 整页崩溃。
  //
  // 用真正的 TS AST 而不是正则：正则无法区分「读变量 items」与「类型注解
  // { items: X[] }」「属性访问 payload.items」，会产生大量误报。
  const ts = (await import("typescript")).default;
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { line: lineOf } = (() => {
    const cache = new Map();
    return {
      line: (pos) => {
        if (!cache.has(pos)) cache.set(pos, source.getLineAndCharacterOfPosition(pos).line);
        return cache.get(pos);
      },
    };
  })();

  const problems = [];

  // 逐个函数组件（大写开头的 function）检查
  const visitComponent = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && node.body) {
      const name = node.name.text;
      // 1) 收集函数体内顶层语句里的 const 声明（含解构），记录其标识符与位置
      const declared = new Map();
      for (const statement of node.body.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          const names = [];
          const collect = (n) => {
            if (ts.isIdentifier(n)) names.push(n);
            else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n.elements.forEach((el) => { if (ts.isBindingElement(el)) collect(el.name); });
          };
          collect(decl.name);
          for (const id of names) if (!declared.has(id.text)) declared.set(id.text, id);
        }
      }
      // 2) 遍历函数体内所有「值位置」的标识符引用，若引用的声明在本语句之后则记为问题
      const check = (n) => {
        if (ts.isIdentifier(n)) {
          const decl = declared.get(n.text);
          // 只关心本组件声明的标识符
          if (!decl) return;
          // 只看值位置：排除属性名（a.b 中的 b）、类型位置、声明自身
          const parent = n.parent;
          const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
            (ts.isPropertyAssignment(parent) && parent.name === n) ||
            (ts.isPropertySignature(parent) && parent.name === n) ||
            (ts.isQualifiedName(parent) && parent.right === n);
          const isDeclarationItself = (ts.isVariableDeclaration(parent) && parent.name === n) ||
            (ts.isBindingElement(parent) && parent.name === n);
          // 类型位置（如 `{ items: BackendSchedule[] }`）：有类型上下文即跳过
          if (isPropertyName || isDeclarationItself) return;
          // 判断该引用是否处于类型注解/类型实参内
          let cur = parent;
          let inTypePosition = false;
          while (cur && cur !== node.body) {
            if (ts.isTypeNode(cur) || ts.isTypeReferenceNode(cur) || ts.isTypeLiteralNode(cur) || ts.isInterfaceDeclaration(cur)) { inTypePosition = true; break; }
            cur = cur.parent;
          }
          if (inTypePosition) return;

          if (n.pos < decl.pos) {
            const line = (pos) => {
              try { return lineOf(pos) + 1; } catch { return "?"; }
            };
            problems.push(`${name}: line ${line(n.getStart(source))} reads '${n.text}' declared at line ${line(decl.getStart(source))}`);
          }
          return;
        }
        ts.forEachChild(n, check);
      };
      check(node.body);
    }
    ts.forEachChild(node, visitComponent);
  };
  visitComponent(source);

  const unique = [...new Set(problems)];
  assert.deepEqual(unique, [], `发现 const 前置引用（会导致 TDZ 崩溃）:\n${unique.join("\n")}`);
});
