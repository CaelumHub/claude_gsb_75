/* Template deploy simulation preview (shared by templates.html and deploy.html).
 *
 * Flow: the user fills in constructor args and clicks "模拟预览"; the backend
 * dry-runs init() on an isolated copy of the chain state and returns the exact
 * initial storage, events and transfers — plus a ready-to-submit signed deploy
 * transaction (prepared_tx).  The user can tweak the args and preview again as
 * many times as they like; "确认部署" submits the last previewed tx, so the
 * real contract ends up in exactly the state that was previewed.
 */

const Preview = (function () {
  /* Render typed constructor inputs inside ``container``.
     ``spec`` is the template's constructor descriptor list; when it is null
     (raw code on the deploy page) a single JSON-array input is rendered. */
  function renderFields(container, spec) {
    if (!spec || !spec.length) {
      container.innerHTML =
        `<div class="hint">该合约无构造参数（init 不接收参数）。</div>`;
      return;
    }
    container.innerHTML = spec.map((p, i) => {
      const type = p.type || "string";
      const ph = {
        string: "文本，如 MyToken",
        int: "整数，如 1000",
        address: "0x 开头 40 位地址",
        list: "列表 JSON，如 [\"Alice\",\"Bob\"]",
      }[type] || "";
      return `<div class="field">
        <label>${esc(p.name)} <span class="badge gray sm">${esc(type)}</span>
          <span class="hint">${esc(p.desc || "")}</span></label>
        ${type === "list"
          ? `<input class="mono pv-arg" data-i="${i}" data-type="${esc(type)}"
                    placeholder='${esc(ph)}' value='["候选A","候选B"]'>`
          : `<input class="pv-arg" data-i="${i}" data-type="${esc(type)}"
                    placeholder="${esc(ph)}" value="${type === "int" ? "0" : ""}">`}
      </div>`;
    }).join("");
  }

  /* Read a JSON-array input (deploy page raw-code mode). */
  function readJsonArgs(input) {
    const raw = input.value.trim() || "[]";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { error: "构造参数不是合法 JSON" };
    }
    if (!Array.isArray(parsed)) return { error: "构造参数必须是 JSON 数组" };
    return { args: parsed };
  }

  /* Read typed inputs and parse list-type values to arrays for the backend
     (the backend performs the authoritative type coercion/validation). */
  function collectArgs(root) {
    const inputs = $$(".pv-arg", root);
    const args = [];
    for (const inp of inputs) {
      const type = inp.getAttribute("data-type");
      if (type === "int") {
        const v = inp.value.trim();
        if (v === "") return { error: "请填写整数参数" };
        args.push(Number(v));
      } else if (type === "list") {
        try {
          const v = JSON.parse(inp.value.trim() || "[]");
          if (!Array.isArray(v)) return { error: "列表参数必须是 JSON 数组" };
          args.push(v);
        } catch (e) {
          return { error: "列表参数不是合法 JSON" };
        }
      } else {
        args.push(inp.value);
      }
    }
    return { args };
  }

  function request({ template, code, sender, fee, args }) {
    const body = { sender, fee, args };
    if (template) body.template = template;
    if (code) body.code = code;
    return API.post("/api/templates/preview", body);
  }

  /* ---------- rendering ---------- */
  function fmtVal(v) {
    if (typeof v === "string") return esc(JSON.stringify(v));
    try {
      return esc(JSON.stringify(v));
    } catch (e) {
      return esc(String(v));
    }
  }

  function storageTable(storage) {
    const keys = Object.keys(storage).sort();
    if (!keys.length) {
      return `<div class="hint">（无初始状态键）</div>`;
    }
    return `<div class="table-wrap"><table><thead><tr>
        <th style="width:45%;">状态键</th><th>初始值</th></tr></thead><tbody>
      ${keys.map((k) => `<tr>
        <td class="mono" style="word-break:break-all;">${esc(k)}</td>
        <td class="mono small" style="word-break:break-all;">${fmtVal(storage[k])}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
  }

  function eventsList(events) {
    if (!events || !events.length) {
      return `<div class="hint">（init 未产生事件）</div>`;
    }
    return events.map((e) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:6px 0;">
        <div class="flex"><span class="badge purple">#${e.seq || 0}</span>
          <strong style="margin-left:8px;">${esc(e.event)}</strong></div>
        <pre class="code small" style="margin-top:6px;max-height:120px;">${esc(JSON.stringify(e.data, null, 2))}</pre>
      </div>`).join("");
  }

  function transfersList(transfers) {
    if (!transfers || !transfers.length) {
      return `<div class="hint">（init 未发起链上转账）</div>`;
    }
    return `<div class="table-wrap"><table><thead><tr>
        <th>#</th><th>收款方</th><th>金额</th></tr></thead><tbody>
      ${transfers.map((t, i) => `<tr>
        <td class="mono-num">${i + 1}</td>
        <td class="hash mono" title="${esc(t.to)}">${fmt.addr(t.to, 8)}</td>
        <td class="mono-num">${fmt.amount(t.amount)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
  }

  /* Render the result of a preview call into ``box``.
     ``onDeploy`` is called with the prepared tx dict when the user confirms. */
  function render(box, r, onDeploy) {
    if (!r.ok) {
      const stageLabel = r.stage === "params" ? "参数问题" : "模拟执行失败";
      const hint = r.stage === "params"
        ? "请根据提示调整参数后重新预览，无需上链。"
        : "按当前参数部署，init() 将抛出以下错误并导致部署失败（状态回滚）：";
      box.innerHTML = `
        <div class="badge red" style="margin-bottom:8px;">✗ ${stageLabel}：部署将失败</div>
        <div class="hint" style="margin-bottom:6px;">${esc(hint)}</div>
        <pre class="code" style="padding:10px;border-color:rgba(248,113,113,.4);">${esc(r.error || "")}</pre>
        ${r.address ? `<div class="hint" style="margin-top:8px;">预测地址：<span class="mono">${fmt.addr(r.address, 10)}</span>（不会上链）</div>` : ""}`;
      return;
    }
    const warnings = (r.warnings || []).map((w) =>
      `<div class="badge amber" style="display:inline-flex;margin:4px 6px 0 0;">⚠ ${esc(w)}</div>`
    ).join("");
    const deployable = !!r.prepared_tx;
    box.innerHTML = `
      <div class="flex">
        <span class="badge green">✓ 模拟成功：按当前参数可以部署</span>
        <span class="spacer"></span>
        <span class="badge blue sm">${r.storage_keys} 个状态键</span>
        <span class="badge purple sm">${r.events.length} 个事件</span>
        <span class="badge gray sm">${r.transfers.length} 笔转账</span>
      </div>
      ${warnings ? `<div style="margin:8px 0 2px;">${warnings}</div>` : ""}
      <div class="small muted" style="margin:10px 0 4px;line-height:1.9;">
        预测合约地址：<span class="mono" title="${esc(r.address)}">${esc(r.address)}</span><br>
        部署交易 ID：<span class="mono">${fmt.hash(r.txid, 16)}</span><br>
        将在区块 <span class="mono-num">#${r.height}</span> 之后打包
      </div>
      <div class="section-title" style="margin-top:10px;">初始状态（部署后即写入）</div>
      <div class="pv-storage">${storageTable(r.storage)}</div>
      <div class="section-title" style="margin-top:12px;">初始事件（init 触发）</div>
      <div class="pv-events">${eventsList(r.events)}</div>
      <div class="section-title" style="margin-top:12px;">链上转账（init 内 transfer）</div>
      <div class="pv-transfers">${transfersList(r.transfers)}</div>
      <div class="flex" style="margin-top:14px;">
        <button class="btn green sm pv-deploy" ${deployable ? "" : "disabled"}>
          🚀 使用以上参数确认部署</button>
        <span class="hint" style="margin-left:10px;">部署前可继续修改参数并重新预览；实际部署结果与本次预览完全一致。
          ${deployable ? "" : "（部署账户不在本节点钱包，无法直接提交）"}</span>
      </div>`;
    const btn = $(".pv-deploy", box);
    if (btn && deployable) {
      btn.addEventListener("click", () => onDeploy(r));
    }
  }

  /* Submit the prepared deploy tx.  Returns the parsed response. */
  async function deployPrepared(preparedTx) {
    return API.post("/api/tx/submit", preparedTx);
  }

  return { renderFields, readJsonArgs, collectArgs, request, render,
           deployPrepared };
})();
