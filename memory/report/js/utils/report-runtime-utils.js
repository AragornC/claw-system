(function(globalObj) {
  function escapeHtml(valueLike) {
    return String(valueLike == null ? "" : valueLike)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSelectValueSafe(selectElLike, fallbackLike) {
    const el = selectElLike;
    if (!el) return String(fallbackLike || "");
    return String(el.value || fallbackLike || "");
  }

  function setSelectValueSafe(selectElLike, valueLike) {
    const el = selectElLike;
    if (!el) return;
    const value = String(valueLike || "");
    const options = Array.from(el.options || []).map(function(op) { return String(op?.value || ""); });
    el.value = options.includes(value) ? value : "";
  }

  function normalizePresetName(nameLike) {
    const value = String(nameLike || "").trim();
    const compact = value.split(/\s+/).join(" ");
    return compact.slice(0, 28);
  }

  function syncSelectOptions(selectEl, valuesLike, defaultText, keepValue, labelFnLike, escapeHtmlFnLike) {
    const el = selectEl;
    if (!el) return;
    const values = Array.isArray(valuesLike) ? valuesLike.map(function(v) { return String(v || "").trim(); }).filter(Boolean) : [];
    const selected = String(keepValue != null ? keepValue : el.value || "");
    const labelFn = typeof labelFnLike === "function" ? labelFnLike : null;
    const esc = typeof escapeHtmlFnLike === "function" ? escapeHtmlFnLike : escapeHtml;
    const options = ['<option value="">' + esc(defaultText || "全部") + "</option>"]
      .concat(values.map(function(v) {
        const labelRaw = labelFn ? String(labelFn(v) || v) : v;
        return '<option value="' + esc(v) + '">' + esc(labelRaw) + "</option>";
      }));
    el.innerHTML = options.join("");
    if (selected && values.includes(selected)) el.value = selected;
    else if (!selected) el.value = "";
  }

  globalObj.reportRuntimeUtils = {
    escapeHtml: escapeHtml,
    getSelectValueSafe: getSelectValueSafe,
    setSelectValueSafe: setSelectValueSafe,
    normalizePresetName: normalizePresetName,
    syncSelectOptions: syncSelectOptions,
  };
})(typeof window !== "undefined" ? window : this);
