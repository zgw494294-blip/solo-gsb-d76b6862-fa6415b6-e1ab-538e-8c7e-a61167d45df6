"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  mergeIds: [], // 勾选待合并的两条条款 id
  splittingId: null, // 打开拆分选择器的条款 id（打开期间阻止其他改稿操作）
  splitOffset: null, // 拆分分界：内部正文中的字符位置（按 Unicode 码位计，与后端一致）
  splitRefsTo: "front", // 原指向被拆条款的引用落到 front（前段）还是 back（后段）
  idCounter: 0, // 本草稿已用过的最大身份号：拆分新段取 idCounter+1，删除/合并移除的身份不复用
  preview: null, // 服务端 /api/preview 返回；仅当 previewFresh 为真时与当前草稿对应
  previewError: null, // 最近一次预览失败的错误信息（数组）；成功一次或重新导入后清空
  renderedRev: null, // 页面当前 DOM 所呈现草稿的修订号；预览失败时据此判断列表是否停留在旧编号
  renderedSplittingId: null, // 当前 DOM 渲染时正在打开拆分选择器的条款（null 表示没有）
  renderedEditingId: null, // 当前 DOM 渲染时正在编辑的条款（null 表示没有）
  dragId: null,
  epoch: 0, // 草稿世代：导入成功 / 重新导入时 +1；上一草稿的迟到响应一律丢弃
  rev: 0, // 草稿修订号：任何本地改动 +1；响应发出后草稿又有改动的，响应不再适用
  previewFresh: false, // 页面预览是否已追上最新草稿；未追上时禁止下载与合并
  importing: false, // /api/import 在途（期间忽略重复提交）
  saving: false, // /api/save 在途
  merging: false, // /api/merge 在途（期间阻止编辑 / 删除 / 重排 / 勾选 / 重复合并）
  splitting: false, // /api/split 在途（期间阻止其他改稿）
  exporting: false, // /api/export 在途
};

const MAX_CLAUSES = 40; // 与后端 MAX_LINES 一致：拆分后总数不能超过它

let previewSeq = 0; // 预览请求序号：只采用最后一次发出的预览响应
let exportSeq = 0; // 下载请求序号：只有仍持有它的下载能收尾按钮；重新导入 / 新下载会作废旧下载的收尾权
let previewInFlight = false; // 是否已有 /api/preview 在途：防止重试预览重复提交

const MARKER = /\[\[(?:原(\d+)\?|(\d+))\]\]/g; // 预览文本中的引用形态

const $ = (sel) => document.querySelector(sel);

const importPanel = $("#import-panel");
const desk = $("#desk");
const importText = $("#import-text");
const importErrors = $("#import-errors");
const importBtn = $("#import-btn");
const clauseList = $("#clause-list");
const previewText = $("#preview-text");
const brokenBanner = $("#broken-banner");
const previewErrorBanner = $("#preview-error-banner");
const downloadBtn = $("#download-btn");
const mergeBtn = $("#merge-btn");
const statCount = $("#stat-count");
const statBroken = $("#stat-broken");

// --------------------------------------------------------------------------- //
// 工具
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 可能已收到响应头（甚至 200）但正文在读取完成前中断：此时 res.json() 会因
  // 内容不完整而拒绝。不能把这种情况吞成空对象当作成功，否则上层会按“成功但
  // 缺字段”提交状态（清空列表、解锁下载 / 跳转），须按可恢复失败处理。
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("api error");
    err.status = res.status;
    err.errors = (data && data.detail && data.detail.errors) || ["请求失败"];
    throw err;
  }
  if (!data || typeof data !== "object") {
    // 200 响应头已到达、正文却读取中断 / 无法解析：与连接失败一样可重试
    const err = new Error("response body interrupted");
    err.status = res.status;
    err.errors = ["响应正文在读取完成前中断（已收到响应头但内容不完整），请检查网络后重试。"];
    throw err;
  }
  return data;
}

// 把任何失败（服务端 4xx/5xx、JSON 解析失败、断网等 TypeError）归一成可展示的字符串数组。
// 网络异常时 e.errors 可能不存在，直接 .join() 会再抛异常导致失败信息显示不出来。
function errorList(e) {
  const raw = e && e.errors;
  if (Array.isArray(raw) && raw.length) return raw.map((m) => String(m));
  if (typeof raw === "string" && raw) return [raw];
  const message = e && typeof e.message === "string" && e.message ? e.message : "";
  return [message ? `请求失败（${message}），请检查网络后重试。` : "请求失败，请检查网络后重试。"];
}

function snapshot() {
  return {
    order_ids: state.orderIds,
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// --------------------------------------------------------------------------- //
// 草稿改动与工具栏状态
// --------------------------------------------------------------------------- //
// 任何本地草稿改动都要经过 touch()：修订号 +1（使在途响应失效）、
// 标记预览未追上最新草稿（期间禁止下载 / 合并），直到下一次预览响应被采用。
function touch() {
  state.rev += 1;
  state.previewFresh = false;
  syncToolbar();
}

function syncToolbar() {
  updateMergeBtn();
  updateDownloadBtn();
  syncBusy();
}

// 列表是否应整体暂停操作（置灰、拦截事件，结束后自动恢复）：
// - 合并 / 拆分提交在途；
// - 预览失败且页面停留在旧编号（renderedRev 与当前草稿不一致）；
// - 预览失败且刚打开的拆分选择器 / 编辑器尚未渲染出来（DOM 里没有对应入口）。
// 已成功渲染的拆分选择器在预览失败时仍可继续操作（选分界、确认、取消），
// 其重试入口在失败横幅上。
function listLocked() {
  if (state.merging || state.splitting) return true;
  if (state.previewError === null) return false;
  if (state.renderedRev !== state.rev) return true;
  if (state.splittingId !== null && state.renderedSplittingId !== state.splittingId) return true;
  if (state.editingId !== null && state.renderedEditingId !== state.editingId) return true;
  return false;
}

function syncBusy() {
  clauseList.classList.toggle("busy", listLocked());
}

// 预览失败横幅：始终可重试预览；拆分选择器或编辑器尚未渲染出来时还提供对应
// 的取消入口（成功取消后恢复原草稿卡片操作）。拆分选择器已渲染时，其卡片内
// 的「取消 / 确认拆分」与分界选择照常可用。
function syncPreviewErrorBanner() {
  const errors = state.previewError;
  if (errors === null) {
    previewErrorBanner.hidden = true;
    previewErrorBanner.textContent = "";
    return;
  }
  const stale =
    state.renderedRev !== state.rev ||
    (state.splittingId !== null && state.renderedSplittingId !== state.splittingId) ||
    (state.editingId !== null && state.renderedEditingId !== state.editingId);
  const cancel = state.splittingId
    ? '<button type="button" data-action="preview-cancel-split">取消拆分</button>'
    : state.editingId
      ? '<button type="button" data-action="preview-cancel-edit">取消编辑</button>'
      : "";
  const scope = stale
    ? "草稿改动（可能含刚完成的拆分、合并或保存）已保留，但页面仍停留在旧内容：列表操作、引用跳转与下载已暂停。"
    : "原草稿未改动，可继续当前拆分选择，或取消后恢复卡片操作。";
  previewErrorBanner.innerHTML =
    `<strong>预览刷新失败。</strong>${scope}` +
    `<ul>${errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` +
    `<div class="preview-error-actions">` +
    `<button type="button" class="primary" data-action="preview-retry"${
      previewInFlight ? " disabled" : ""
    }>${previewInFlight ? "重试中…" : "重试预览"}</button>${cancel}</div>`;
  previewErrorBanner.hidden = false;
}

function updateMergeBtn() {
  if (state.merging) {
    mergeBtn.disabled = true;
    mergeBtn.textContent = "合并中…";
    return;
  }
  mergeBtn.disabled =
    state.editingId !== null ||
    state.splittingId !== null ||
    state.splitting ||
    !state.previewFresh ||
    state.mergeIds.length !== 2;
  mergeBtn.textContent =
    state.mergeIds.length === 2 ? "合并所选（2 条）" : "合并所选";
}

function updateDownloadBtn() {
  downloadBtn.disabled =
    state.exporting ||
    state.merging ||
    state.splitting ||
    !state.previewFresh ||
    !state.preview ||
    state.preview.has_broken;
  downloadBtn.textContent = state.exporting ? "下载中…" : "下载纯文本";
}

// --------------------------------------------------------------------------- //
// 导入
// --------------------------------------------------------------------------- //
const SAMPLE = [
  "1|甲方应在合同签订后七日内交付设备。",
  "2|乙方按第 [[1]] 条验收合格后三十日内付款。",
  "3|设备规格与数量见附件，不符合的按 [[1]] 退换。",
  "4|因本合同产生的争议，按 [[5]] 处理。",
  "5|争议提交甲方所在地仲裁委员会仲裁。",
].join("\n");

$("#sample-btn").addEventListener("click", () => {
  importText.value = SAMPLE;
  importErrors.hidden = true;
});

importBtn.addEventListener("click", async () => {
  if (state.importing) return; // 忽略等待期间的重复提交
  state.importing = true;
  importBtn.disabled = true;
  importBtn.textContent = "导入中…";
  try {
    const data = await api("/api/import", { text: importText.value });
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: c.original,
      body: c.body,
    }));
    state.orderIds = state.clauses.map((c) => c.id);
    state.editingId = null;
    state.mergeIds = [];
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    state.splitting = false;
    state.idCounter = data.clauses.length; // 导入身份为 c1..cN，拆分新身份从 N+1 起
    state.preview = null;
    state.previewError = null;
    state.renderedRev = null;
    state.renderedSplittingId = null;
    state.renderedEditingId = null;
    state.epoch += 1; // 新草稿世代：上一草稿的在途请求全部作废
    previewInFlight = false;
    touch();
    importErrors.hidden = true;
    importPanel.hidden = true;
    desk.hidden = false;
    render();
  } catch (e) {
    importErrors.innerHTML = errorList(e).map((m) => `<li>${esc(m)}</li>`).join("");
    importErrors.hidden = false;
  } finally {
    state.importing = false;
    importBtn.disabled = false;
    importBtn.textContent = "导入";
  }
});

$("#reimport-btn").addEventListener("click", () => {
  if (!confirm("重新导入将丢弃当前草稿，确定继续？")) return;
  // 世代 +1：所有在途请求（预览 / 保存 / 合并 / 下载）的迟到响应都会被丢弃，
  // 其成功或失败不再影响新草稿及提示、按钮状态
  state.epoch += 1;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.mergeIds = [];
  state.splittingId = null;
  state.splitOffset = null;
  state.splitRefsTo = "front";
  state.idCounter = 0;
  state.preview = null;
  state.previewError = null;
  state.renderedRev = null;
  state.renderedSplittingId = null;
  state.renderedEditingId = null;
  state.previewFresh = false;
  state.rev += 1;
  state.saving = false;
  state.merging = false;
  state.splitting = false;
  state.exporting = false;
  exportSeq += 1; // 作废旧下载对等待状态的收尾权：其成功或失败都不得解锁新草稿的下载按钮
  previewInFlight = false; // 上一草稿在途预览的收尾将因世代不符而直接返回，这里复位在途态
  desk.hidden = true;
  importPanel.hidden = false;
  syncPreviewErrorBanner();
  syncToolbar();
});

// --------------------------------------------------------------------------- //
// 渲染（数据全部以服务端 /api/preview 为准）
// --------------------------------------------------------------------------- //
async function render() {
  const epoch = state.epoch;
  const rev = state.rev;
  const seq = ++previewSeq;
  // 在途标记仅由“当前世代、最后一次”的 render 收尾，迟到响应（已重新导入或
  // 被更新的预览取代）不得清掉新请求的在途状态，也不得改动新稿提示与按钮。
  previewInFlight = true;
  syncPreviewErrorBanner();
  syncBusy();
  try {
    await renderPreview(epoch, rev, seq);
  } finally {
    // 已重新导入：旧请求（拆分/合并后的预览等）的响应与收尾一律不得改动
    // 新稿的列表、提示或按钮；在途标记由重新导入处理直接复位
    if (epoch !== state.epoch) return;
    if (seq === previewSeq) previewInFlight = false; // 被更新预览取代时，由最新者收尾
    syncPreviewErrorBanner();
    syncBusy();
  }
}

async function renderPreview(epoch, rev, seq) {
  let data;
  try {
    data = await api("/api/preview", snapshot());
    // 只有“完整读到的有效预览”才允许提交状态：正文中断等情况下 api() 已抛错；
    // 这里再校验响应形态，任何缺字段 / 字段形态不符的响应都按可恢复失败处理，
    // 绝不先提交成功状态（不清空列表、不更新引用跳转与下载状态）。
    const itemOk =
      data &&
      Array.isArray(data.items) &&
      data.items.every(
        (it) =>
          it &&
          typeof it.id === "string" &&
          Number.isInteger(it.display) &&
          typeof it.text === "string" &&
          Array.isArray(it.broken),
      );
    if (!itemOk || typeof data.has_broken !== "boolean") {
      const err = new Error("invalid preview body");
      err.errors = ["预览响应内容不完整或无法识别，草稿已保留，请重试预览。"];
      throw err;
    }
  } catch (e) {
    if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return; // 迟到响应：丢弃
    // 预览失败（含已收到 200 响应头但正文读取中断）：保留当前草稿与既有 DOM，
    // 不回滚任何已完成的改动，也不清空列表；显示失败信息并重试/取消入口，
    // 列表、引用跳转、下载与合并工具栏在预览恢复前保持锁定
    state.previewFresh = false;
    state.previewError = errorList(e);
    syncToolbar();
    syncPreviewErrorBanner();
    syncBusy();
    return;
  }
  // 只采用仍适用于当前草稿的响应：之后已发出更新的预览、或草稿已变化 / 已重新导入，则丢弃
  if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return;
  state.preview = data;
  state.previewFresh = true;
  state.previewError = null;
  state.renderedRev = rev;
  state.renderedSplittingId = state.splittingId;
  state.renderedEditingId = state.editingId;

  clauseList.classList.toggle("busy", state.merging || state.splitting);
  clauseList.textContent = "";
  let brokenTotal = 0;
  const brokenLines = [];

  for (const item of data.items) {
    brokenTotal += item.broken.length;
    if (item.broken.length) {
      const marks = item.broken.map((b) => `[[原${b.original}?]]`).join("、");
      brokenLines.push(
        `<li>第 ${item.display} 条（导入时原第 ${item.original} 条）中的 ${esc(marks)} 已失去目标（原条款已删除）</li>`,
      );
    }

    const li = document.createElement("li");
    li.className =
      "card" +
      (item.broken.length ? " source-broken" : "") +
      (state.mergeIds.includes(item.id) ? " selected" : "");
    li.id = `card-${item.id}`;
    li.dataset.id = item.id;

    const isEditing = state.editingId === item.id;
    const isSplitting = state.splittingId === item.id;
    const locked = state.editingId || state.splittingId; // 编辑或拆分选择进行中：锁定其他操作
    const atMax = state.orderIds.length >= MAX_CLAUSES;
    li.innerHTML = `
      <div class="card-head">
        <input type="checkbox" class="merge-pick" title="勾选后与另一条合并（按当前显示顺序）"
          ${state.mergeIds.includes(item.id) ? "checked" : ""}
          ${locked ? "disabled" : ""} />
        <span class="grip" title="拖拽调整顺序">⠿</span>
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="card-actions">
          ${
            isEditing || isSplitting
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || locked ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || locked ? "disabled" : ""
                 }>↓</button>
                 <button data-action="edit" ${locked ? "disabled" : ""}>编辑正文</button>
                 <button data-action="split" ${locked || atMax ? "disabled" : ""}
                   title="${
                     atMax
                       ? `条款总数已达 ${MAX_CLAUSES} 条上限，不能再拆分`
                       : "在选定分界处把本条已保存正文拆成前后两条"
                   }">拆分</button>
                 <button data-action="delete" class="danger" ${
                   locked ? "disabled" : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : isSplitting ? splitHtml(item) : `<div class="card-body">${bodyHtml(item)}</div>`}
    `;
    clauseList.appendChild(li);
  }

  // 顶部状态
  statCount.textContent = `共 ${data.items.length} 条`;
  statBroken.hidden = brokenTotal === 0;
  statBroken.textContent = `${brokenTotal} 处失效引用`;
  syncToolbar();

  // 失效引用横幅
  if (brokenLines.length) {
    brokenBanner.hidden = false;
    brokenBanner.innerHTML =
      `<strong>存在失效引用，修复前禁止下载。</strong>请编辑下列条款，把失效标记改为有效的 [[当前编号]]，或删除该标记：<ul>${brokenLines.join(
        "",
      )}</ul>`;
  } else {
    brokenBanner.hidden = true;
    brokenBanner.textContent = "";
  }

  // 纯文本预览：直接用服务端解析出的 text 拼装，与 /api/export 完全同一逻辑
  const plain = data.items.map((it) => `${it.display}|${it.text}`).join("\n");
  previewText.textContent = plain;
  previewText.classList.toggle("blocked", data.has_broken);

  // 拆分选择器打开时，按当前状态恢复其分界选中态与按钮可用态
  if (state.splittingId) {
    const card = document.getElementById(`card-${state.splittingId}`);
    if (card) refreshSplitUi(card);
  }

  attachDnd();
}

// 预览正文：把 [[n]] 渲染为可点击引用、[[原X?]] 渲染为失效标记
// 仅在预览响应与当前草稿一致时才会执行（render 已校验），
// 因此这里用 state.orderIds 解释 [[n]] 不会拿新顺序去套旧编号
function bodyHtml(item) {
  let html = "";
  let last = 0;
  for (const m of item.text.matchAll(MARKER)) {
    html += esc(item.text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead" title="失效引用：原第 ${m[1]} 条已删除，请编辑本条修复">[[原${m[1]}?]]</span>`;
    } else {
      const target = state.orderIds[parseInt(m[2], 10) - 1];
      html += `<button type="button" class="ref" data-goto="${esc(target)}">[[${m[2]}]]</button>`;
    }
    last = m.index + m[0].length;
  }
  html += esc(item.text.slice(last));
  return html;
}

function editorHtml(item) {
  return `
    <div class="editor">
      <textarea data-role="edit-text">${esc(item.text)}</textarea>
      <div class="editor-actions">
        <button data-action="save" class="primary">保存</button>
        <button data-action="cancel">取消</button>
        <span class="edit-hint">
          单行条款（回车不换行）；[[数字]] 按保存当刻的显示编号绑定；${
            item.broken.length ? "<b>请先修复 [[原X?]] 标记</b>，否则无法保存；" : ""
          }Ctrl+Enter 快速保存
        </span>
      </div>
      <ul class="edit-errors" data-role="edit-errors" hidden></ul>
    </div>`;
}

// --------------------------------------------------------------------------- //
// 拆分一条条款
// --------------------------------------------------------------------------- //
// 把内部正文解析为文本 / 引用标记 token 序列（内部形态已由服务端校验，标记一定完整）
function splitTokens(body) {
  const tokens = [];
  const re = /\[\[(c\d+)\]\]/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index > last) tokens.push({ type: "text", text: body.slice(last, m.index) });
    tokens.push({ type: "mark", id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) tokens.push({ type: "text", text: body.slice(last) });
  return tokens;
}

// 引用标记在页面上的显示形态：有效引用为当前显示编号，失效引用为 [[原X?]]
function markDisplay(id) {
  const pos = state.orderIds.indexOf(id);
  return pos >= 0 ? `[[${pos + 1}]]` : `[[原${id.slice(1)}?]]`;
}

function gapHtml(offset) {
  return `<button type="button" class="split-gap" data-gap="${offset}" title="在此处分拆"></button>`;
}

// 拆分选择器：在已保存正文的字符分界处放置拆分点。
// 分界位置按 Unicode 码位计（for...of 逐码位迭代），与服务端 Python 字符串下标一致；
// 引用标记整体作为一个原子，内部不提供分界，保证分界不会切开有效或失效引用标记。
function splitHtml(item) {
  const clause = state.clauses.find((c) => c.id === item.id);
  const tokens = splitTokens(clause.body);
  let offset = 0;
  let body = gapHtml(0);
  for (const tok of tokens) {
    if (tok.type === "text") {
      for (const ch of tok.text) {
        offset += 1;
        body += `<span class="split-ch">${esc(ch)}</span>${gapHtml(offset)}`;
      }
    } else {
      offset += tok.id.length + 4; // [[cX]] 全为 ASCII，两种计数下长度一致
      body += `<span class="ref split-mark">${esc(markDisplay(tok.id))}</span>${gapHtml(offset)}`;
    }
  }
  return `
    <div class="splitter">
      <div class="split-hint">点击字符之间的竖线放置拆分分界（引用标记不可切开，两段都不能只含空白，其余字符原样保留）：</div>
      <div class="split-body">${body}</div>
      <div class="split-opts">
        <span>原指向本条的引用（含本条正文中的自引用）统一改指：</span>
        <label><input type="radio" data-role="split-refs" name="split-refs" value="front"
          ${state.splitRefsTo === "front" ? "checked" : ""} /> 前段（沿用原身份）</label>
        <label><input type="radio" data-role="split-refs" name="split-refs" value="back"
          ${state.splitRefsTo === "back" ? "checked" : ""} /> 后段（获得新身份）</label>
      </div>
      <div class="editor-actions">
        <button data-action="split-confirm" class="primary" disabled>确认拆分</button>
        <button data-action="split-cancel">取消</button>
        <span class="edit-hint" data-role="split-hint"></span>
      </div>
      <ul class="edit-errors" data-role="split-errors" hidden></ul>
    </div>`;
}

// 按 state.splitOffset / splitRefsTo 刷新拆分选择器的选中态、提示与确认按钮可用态
function refreshSplitUi(card) {
  const id = card.dataset.id;
  const offset = state.splitOffset;
  card
    .querySelectorAll(".split-gap")
    .forEach((g) => g.classList.toggle("on", offset !== null && parseInt(g.dataset.gap, 10) === offset));
  const confirmBtn = card.querySelector('[data-action="split-confirm"]');
  const hint = card.querySelector('[data-role="split-hint"]');
  const errBox = card.querySelector('[data-role="split-errors"]');
  if (errBox) errBox.hidden = true;
  if (offset === null) {
    if (confirmBtn) confirmBtn.disabled = true;
    if (hint) hint.textContent = "尚未选择分界位置。";
    return;
  }
  const clause = state.clauses.find((c) => c.id === id);
  const chars = [...clause.body]; // 按码位切分，与服务端 offset 口径一致
  const ok =
    chars.slice(0, offset).join("").trim() !== "" &&
    chars.slice(offset).join("").trim() !== "";
  if (confirmBtn) confirmBtn.disabled = !ok;
  if (hint) {
    hint.textContent = ok
      ? `分界已选：前段 ${offset} 个字符、后段 ${chars.length - offset} 个字符。`
      : "该分界会让其中一段只含空白，请另选位置。";
  }
}

function setSplitBusy(id, busy) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const confirmBtn = card.querySelector('[data-action="split-confirm"]');
  const cancelBtn = card.querySelector('[data-action="split-cancel"]');
  if (confirmBtn) {
    confirmBtn.disabled = busy;
    confirmBtn.textContent = busy ? "拆分中…" : "确认拆分";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

function showSplitError(id, errors) {
  const errBox = document
    .getElementById(`card-${id}`)
    ?.querySelector('[data-role="split-errors"]');
  if (errBox) {
    errBox.innerHTML = errors.map((m) => `<li>${esc(m)}</li>`).join("");
    errBox.hidden = false;
  }
}

async function submitSplit(id) {
  if (state.splitting || state.splittingId !== id) return; // 阻止重复提交
  const clause = state.clauses.find((c) => c.id === id);
  const offset = state.splitOffset;
  if (!clause || offset === null) return;

  // 本地预检（服务端仍会复核；失败一律不改动草稿）
  const chars = [...clause.body];
  if (
    chars.slice(0, offset).join("").trim() === "" ||
    chars.slice(offset).join("").trim() === ""
  ) {
    showSplitError(id, ["拆分后的两段都不能只含空白字符"]);
    return;
  }
  if (state.orderIds.length + 1 > MAX_CLAUSES) {
    showSplitError(id, [`拆分后共 ${state.orderIds.length + 1} 条，超过上限 ${MAX_CLAUSES} 条，不能拆分`]);
    return;
  }

  // 后段新身份：本草稿从未用过的 id（删除/合并移除的身份不复用，失效引用不会复活）
  const newId = `c${state.idCounter + 1}`;
  const epoch = state.epoch;
  // 提交期间阻止其他改稿（列表置灰），成功或失败后恢复
  state.splitting = true;
  syncBusy();
  setSplitBusy(id, true);
  syncToolbar();
  try {
    const data = await api("/api/split", {
      ...snapshot(),
      split_id: id,
      offset,
      new_id: newId,
      refs_to: state.splitRefsTo,
    });
    if (epoch !== state.epoch) return; // 已重新导入：旧拆分结果不得写回新草稿
    // 仅在服务端成功后才改动草稿，保证列表 / 预览 / 引用跳转 / 下载立即对应同一份草稿
    state.orderIds = data.order_ids;
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: parseInt(c.id.slice(1), 10),
      body: c.body,
    }));
    state.idCounter += 1; // 新身份已投入使用，计数推进
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    state.splitting = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    // 拆分请求失败（含断网等异常）：草稿未改动，分界与引用落点保留供重试或取消；
    // 用归一化后的错误信息展示，避免异常对象没有 errors 时提示处理再抛异常
    state.splitting = false;
    setSplitBusy(id, false);
    const card = document.getElementById(`card-${id}`);
    if (card) refreshSplitUi(card);
    showSplitError(id, errorList(e));
  } finally {
    // 重新导入后，旧请求的收尾不得改动新稿的列表状态、提示或按钮
    if (epoch === state.epoch) {
      syncBusy();
      syncToolbar();
    }
  }
}

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
clauseList.addEventListener("change", (ev) => {
  const splitRefs = ev.target.closest('[data-role="split-refs"]');
  if (splitRefs) {
    state.splitRefsTo = splitRefs.value === "back" ? "back" : "front";
    return;
  }
  const pick = ev.target.closest(".merge-pick");
  if (!pick) return;
  const id = pick.closest(".card").dataset.id;
  if (state.merging || state.splitting || listLocked()) {
    pick.checked = state.mergeIds.includes(id); // 合并/拆分提交或预览锁定期间不允许改动选择
    return;
  }
  if (pick.checked) {
    if (state.mergeIds.length >= 2) {
      // 一次只能合并两条：取消本次勾选并提示
      pick.checked = false;
      alert("一次只能合并两条条款：请先取消已勾选的条款。");
      return;
    }
    state.mergeIds.push(id);
  } else {
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
  }
  document.getElementById(`card-${id}`).classList.toggle("selected", pick.checked);
  updateMergeBtn();
});

mergeBtn.addEventListener("click", async () => {
  if (state.merging) return; // 阻止重复提交
  if (state.editingId) {
    alert("请先保存或取消正在编辑的正文，再合并条款。");
    return;
  }
  if (state.mergeIds.length !== 2 || !state.previewFresh || !state.preview) return;

  // 按当前显示顺序确定较前 / 较后条款
  const [a, b] = state.mergeIds;
  const keepId = state.orderIds.indexOf(a) < state.orderIds.indexOf(b) ? a : b;
  const dropId = keepId === a ? b : a;
  const previewById = Object.fromEntries(state.preview.items.map((it) => [it.id, it]));
  const keep = previewById[keepId];
  const drop = previewById[dropId];
  const inbound = state.clauses.filter(
    (c) => c.body.includes(`[[${dropId}]]`),
  ).length;

  const msg =
    `将把当前第 ${drop.display} 条并入第 ${keep.display} 条：\n\n` +
    `第 ${keep.display} 条：${keep.text}\n` +
    `第 ${drop.display} 条：${drop.text}\n\n` +
    `合并后正文（全角分号连接）：\n${keep.text}；${drop.text}\n\n` +
    `合并结果沿用第 ${keep.display} 条（原第 ${keep.original} 条）的位置与身份，` +
    `第 ${drop.display} 条移除，其余条款顺序不变。\n` +
    `共有 ${inbound} 处引用指向第 ${drop.display} 条，合并后全部改指合并结果；` +
    `其他引用不变，已失效引用仍保持失效。\n` +
    `此操作在重新导入或刷新前不可撤销，确定合并？`;
  if (!confirm(msg)) return;

  const epoch = state.epoch;
  // 提交期间阻止编辑 / 删除 / 重排 / 勾选 / 重复合并，成功或失败后恢复
  state.merging = true;
  syncBusy();
  syncToolbar();
  try {
    const data = await api("/api/merge", {
      ...snapshot(),
      keep_id: keepId,
      drop_id: dropId,
    });
    if (epoch !== state.epoch) return; // 已重新导入：旧合并结果不得作用于新草稿
    // 仅在服务端成功后才改动草稿，保证列表 / 预览 / 下载立即对应同一份草稿
    state.orderIds = data.order_ids;
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: parseInt(c.id.slice(1), 10),
      body: c.body,
    }));
    state.mergeIds = [];
    state.merging = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    // 合并失败：草稿未改动，恢复被暂时阻止的操作（勾选保持不变，可修正后重试）
    state.merging = false;
    alert("合并失败，草稿未改动：\n" + errorList(e).join("\n"));
  } finally {
    if (epoch === state.epoch) {
      syncBusy();
      syncToolbar();
    }
  }
});

// --------------------------------------------------------------------------- //
// 列表交互（事件委托）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("click", async (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (goto) {
    // 预览失败、页面停留在旧编号时禁止用旧编号跳转；合并/拆分提交中也不响应
    if (listLocked()) return;
    const card = document.getElementById(`card-${goto.dataset.goto}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    return;
  }

  const gap = ev.target.closest("[data-gap]");
  if (gap) {
    if (state.splitting || listLocked()) return; // 拆分提交 / 列表锁定期间列表已置灰，这里再兜底
    const card = gap.closest(".card");
    if (!card || card.dataset.id !== state.splittingId) return;
    state.splitOffset = parseInt(gap.dataset.gap, 10);
    refreshSplitUi(card);
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const action = btn.dataset.action;

  // 编辑中、拆分选择中、合并/拆分提交中或预览失败致列表锁定时：
  // 阻止 编辑 / 删除 / 重排 / 打开拆分（按钮已禁用，这里再兜底）
  if (
    ["up", "down", "edit", "delete", "split"].includes(action) &&
    (state.editingId || state.splittingId || listLocked())
  )
    return;

  if (action === "up" || action === "down") {
    const idx = state.orderIds.indexOf(id);
    const j = action === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.orderIds.length) return;
    [state.orderIds[idx], state.orderIds[j]] = [state.orderIds[j], state.orderIds[idx]];
    touch();
    render();
  } else if (action === "edit") {
    state.editingId = id;
    render().then(() => {
      const ta = clauseList.querySelector(`#card-${id} textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener("keydown", onEditorKey);
      }
    });
  } else if (action === "delete") {
    const inbound = state.clauses.filter(
      (c) => c.id !== id && c.body.includes(`[[${id}]]`),
    ).length;
    const msg =
      `确定删除该条款？\n` +
      (inbound ? `有 ${inbound} 条条款引用它，删除后这些引用将标为失效，修复前无法下载。\n` : "") +
      `（编号会自动重排，此操作在重新导入或刷新前不可撤销）`;
    if (!confirm(msg)) return;
    state.orderIds = state.orderIds.filter((x) => x !== id);
    state.clauses = state.clauses.filter((c) => c.id !== id);
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
    touch();
    render();
  } else if (action === "cancel") {
    state.editingId = null;
    render();
  } else if (action === "save") {
    await saveEdit(id);
  } else if (action === "split") {
    if (state.orderIds.length >= MAX_CLAUSES) {
      alert(`条款总数已达 ${MAX_CLAUSES} 条上限，不能再拆分。`);
      return;
    }
    state.splittingId = id;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "split-cancel") {
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "split-confirm") {
    await submitSplit(id);
  }
});

// 预览失败横幅：重试预览；或在拆分/编辑器尚未渲染出来时取消并恢复原草稿卡片操作
previewErrorBanner.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "preview-retry") {
    if (previewInFlight) return;
    render();
  } else if (action === "preview-cancel-split") {
    // 原草稿保持不变（拆分尚未成功提交），放弃分界选择并恢复卡片操作
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "preview-cancel-edit") {
    state.editingId = null;
    render();
  }
});

function onEditorKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    // 只处理单行条款：Enter 不插入换行；Ctrl/⌘+Enter 保存
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) saveEdit(state.editingId);
  }
}

async function saveEdit(id) {
  if (state.saving) return; // 忽略等待期间的重复提交
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const text = card.querySelector("textarea").value;
  const epoch = state.epoch;
  state.saving = true;
  setEditorBusy(id, true);
  try {
    const data = await api("/api/save", { ...snapshot(), edit_id: id, text });
    if (epoch !== state.epoch) return; // 已重新导入：旧保存结果不得作用于新草稿
    const clause = state.clauses.find((c) => c.id === id);
    if (clause) clause.body = data.body;
    state.editingId = null;
    state.saving = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    state.saving = false;
    setEditorBusy(id, false);
    // 重新查询当前 DOM：等待期间可能有预览响应重建过编辑器
    const errBox = document
      .getElementById(`card-${id}`)
      ?.querySelector('[data-role="edit-errors"]');
    if (errBox) {
      errBox.innerHTML = errorList(e).map((m) => `<li>${esc(m)}</li>`).join("");
      errBox.hidden = false;
    }
  }
}

// 保存等待期间禁用编辑器按钮，结束后恢复（DOM 可能已被重建，按当前节点操作）
function setEditorBusy(id, busy) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const saveBtn = card.querySelector('[data-action="save"]');
  const cancelBtn = card.querySelector('[data-action="cancel"]');
  if (saveBtn) {
    saveBtn.disabled = busy;
    saveBtn.textContent = busy ? "保存中…" : "保存";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

// --------------------------------------------------------------------------- //
// 拖拽重排
// --------------------------------------------------------------------------- //
function attachDnd() {
  for (const card of clauseList.querySelectorAll(".card")) {
    const grip = card.querySelector(".grip");
    grip.addEventListener("mousedown", () => {
      if (!state.editingId && !state.splittingId && !listLocked())
        card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId || state.splittingId || listLocked()) {
        ev.preventDefault();
        return;
      }
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("dragging");
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!state.dragId || state.dragId === card.dataset.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      card.classList.add("drag-over");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const targetId = card.dataset.id;
      if (!state.dragId || state.dragId === targetId) return;
      const rect = card.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveClause(state.dragId, targetId, after);
    });
  }
}

function moveClause(srcId, targetId, after) {
  const ids = state.orderIds.filter((x) => x !== srcId);
  let idx = ids.indexOf(targetId);
  if (after) idx += 1;
  ids.splice(idx, 0, srcId);
  state.orderIds = ids;
  touch();
  render();
}

// --------------------------------------------------------------------------- //
// 下载（以服务端 /api/export 为准，保证与预览一致）
// --------------------------------------------------------------------------- //
downloadBtn.addEventListener("click", async () => {
  if (downloadBtn.disabled) return; // 预览未追上 / 有失效引用 / 在途时不允许下载
  // 取得本次下载对等待状态的唯一收尾权：等待期间重新导入或又发起一次下载时，
  // 序号会推进，旧下载的响应与收尾一律失效，不能保存旧文件、弹提示或解锁新下载
  const token = ++exportSeq;
  state.exporting = true;
  syncToolbar();
  const epoch = state.epoch;
  const rev = state.rev;
  try {
    const data = await api("/api/export", snapshot());
    if (token !== exportSeq) return; // 已重新导入 / 被新下载取代：旧响应静默丢弃
    if (epoch !== state.epoch) return; // 旧草稿的响应：静默丢弃
    if (rev !== state.rev) {
      // 等待期间草稿又有改动：下载内容已与页面不一致，取消本次下载
      alert("草稿在下载期间又有改动，本次下载已取消，请重新下载。");
      return;
    }
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `clauses-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (token !== exportSeq || epoch !== state.epoch || rev !== state.rev) return; // 已不属于当前下载：不提示
    alert(errorList(e).join("\n"));
  } finally {
    // 只有仍持有收尾权的下载才能清掉等待状态：旧下载提前返回时不得解锁新下载
    if (token === exportSeq) {
      state.exporting = false;
      syncToolbar(); // 按当前草稿与预览状态恢复（可重试 / 可再次下载）
    }
  }
});
