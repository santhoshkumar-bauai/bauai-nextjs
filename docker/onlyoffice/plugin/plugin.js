(function () {
  "use strict";
  var state = { options: null, accessToken: null, proposal: null, context: null };
  var status = document.getElementById("status");
  var proposeButton = document.getElementById("propose");
  var applyButton = document.getElementById("apply");

  function setStatus(message, error) {
    status.textContent = message || "";
    status.style.color = error ? "#b42318" : "#6e6873";
  }
  function pluginOptions() {
    var info = window.Asc.plugin.info || {};
    var options = info.options || window.Asc.plugin.options || {};
    return options[window.Asc.plugin.guid] || options;
  }
  async function digest(value) {
    var bytes = new TextEncoder().encode(String(value || ""));
    var hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map(function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }
  function execute(name, args) {
    return new Promise(function (resolve, reject) {
      try { window.Asc.plugin.executeMethod(name, args || [], resolve); } catch (error) { reject(error); }
    });
  }
  function command(fn) {
    return new Promise(function (resolve, reject) {
      try { window.Asc.plugin.callCommand(fn, false, true, resolve); } catch (error) { reject(error); }
    });
  }
  async function getSelectionContext() {
    var text = await execute("GetSelectedText", [{ Numbering: false, Math: false, TableCellSeparator: "\t", ParaSeparator: "\n", TabSymbol: "\t" }]);
    return { selection: String(text || ""), selectionHash: await digest(text || ""), items: [] };
  }
  async function getSpreadsheetContext() {
    var raw = await command(function () {
      var sheet = Api.GetActiveSheet();
      var selection = Api.GetSelection();
      return JSON.stringify({ id: selection.GetAddress(), range: selection.GetAddress(), sheet: sheet.GetName(), value: String(selection.GetValue() || "") });
    });
    var item = JSON.parse(raw || "{}");
    item.expectedHash = await digest(item.value || "");
    return { selection: item.value || "", selectionHash: item.expectedHash, items: [item] };
  }
  async function getFormsContext() {
    var raw = await command(function () { return JSON.stringify(Api.GetDocument().GetFormsData()); });
    var forms = JSON.parse(raw || "[]");
    var items = [];
    for (var i = 0; i < forms.length; i += 1) {
      var value = forms[i].value == null ? "" : String(forms[i].value);
      items.push({ id: forms[i].key || forms[i].tag || String(i), value: value, label: forms[i].key || forms[i].tag, expectedHash: await digest(value) });
    }
    return { selection: "", items: items };
  }
  async function collectContext(task) {
    var type = window.Asc.plugin.info.editorType;
    if (type === "cell") return getSpreadsheetContext();
    if (task === "prefill") {
      try { return await getFormsContext(); } catch { return getSelectionContext(); }
    }
    return getSelectionContext();
  }
  async function accessToken() {
    if (state.accessToken) return state.accessToken;
    var response = await fetch(state.options.gatewayUrl + "/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editorGrant: state.options.editorGrant }) });
    if (!response.ok) throw new Error("Clara authorization failed.");
    state.accessToken = (await response.json()).accessToken;
    return state.accessToken;
  }
  function renderProposal(proposal) {
    state.proposal = proposal;
    var list = document.getElementById("proposal-list");
    list.textContent = "";
    proposal.operations.forEach(function (operation, index) {
      var row = document.createElement("label"); row.className = "proposal";
      var checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = true; checkbox.dataset.index = String(index);
      var body = document.createElement("div");
      var title = document.createElement("strong"); title.textContent = operation.value.slice(0, 120) || operation.action;
      var rationale = document.createElement("p"); rationale.textContent = operation.rationale;
      var confidence = document.createElement("span"); confidence.className = "confidence"; confidence.textContent = Math.round(operation.confidence * 100) + "% confidence";
      body.append(title, rationale, confidence); row.append(checkbox, body); list.appendChild(row);
    });
    document.getElementById("proposals").hidden = false;
  }
  async function requestProposal() {
    proposeButton.disabled = true; setStatus("Clara is preparing reviewable changes…");
    try {
      var task = document.getElementById("task").value;
      state.context = await collectContext(task);
      if (task !== "prefill" && !state.context.selection) throw new Error("Select text in the document first.");
      var token = await accessToken();
      var response = await fetch(state.options.gatewayUrl + "/operations", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ documentId: state.options.documentId, task: task, instruction: document.getElementById("instruction").value, context: state.context }) });
      if (response.status === 401) { state.accessToken = null; throw new Error("Clara's session expired. Try again."); }
      if (!response.ok) throw new Error("Clara could not create proposals.");
      var result = await response.json(); renderProposal(result.proposal); setStatus(result.proposal.operations.length ? "Review and select the changes to apply." : "No safe changes were found.");
    } catch (error) { setStatus(error.message || "Clara failed.", true); } finally { proposeButton.disabled = false; }
  }
  async function applyWord(operation) {
    await command(function () { Api.GetDocument().SetAssistantTrackRevisions(true, "Clara"); });
    try {
      if (operation.action === "comment") await execute("AddComment", [{ Text: operation.value, UserName: "Clara" }]);
      else if (operation.target.kind === "form" || operation.target.kind === "contentControl") {
        Asc.scope.formKey = operation.target.id; Asc.scope.formValue = operation.value;
        await command(function () { Api.GetDocument().SetFormsData([{ key: Asc.scope.formKey, value: Asc.scope.formValue }]); });
      } else await execute("ReplaceTextSmart", [[operation.value]]);
    } finally { await command(function () { Api.GetDocument().SetAssistantTrackRevisions(false, "Clara"); }); }
  }
  async function applyCell(operation) {
    Asc.scope.range = operation.target.range; Asc.scope.value = operation.value;
    await command(function () { Api.GetActiveSheet().GetRange(Asc.scope.range).SetValue(Asc.scope.value); });
  }
  async function applyPdf(operation) { await execute("SetFormValue", [operation.target.id, operation.value]); }
  async function applySelected() {
    applyButton.disabled = true; setStatus("Applying selected changes…");
    var selected = Array.from(document.querySelectorAll(".proposal input:checked")).map(function (input) { return state.proposal.operations[Number(input.dataset.index)]; });
    var failures = 0;
    for (var i = 0; i < selected.length; i += 1) {
      try {
        var current = await collectContext(document.getElementById("task").value);
        var expected = selected[i].target.expectedHash;
        var currentItem = current.items.find(function (item) { return item.id === selected[i].target.id || item.range === selected[i].target.range; });
        var actual = currentItem ? currentItem.expectedHash : current.selectionHash;
        if (actual && actual !== expected) throw new Error("Target changed");
        if (window.Asc.plugin.info.editorType === "cell") await applyCell(selected[i]);
        else if (window.Asc.plugin.info.editorType === "pdf") await applyPdf(selected[i]);
        else await applyWord(selected[i]);
      } catch { failures += 1; }
    }
    setStatus(failures ? failures + " change(s) were skipped because their target changed or could not be applied." : "Selected changes were applied for review.", failures > 0);
    applyButton.disabled = false;
  }
  window.Asc.plugin.init = function () {
    state.options = pluginOptions();
    if (!state.options || !state.options.gatewayUrl) setStatus("Clara is not configured for this document.", true);
  };
  window.Asc.plugin.button = function () { window.Asc.plugin.executeCommand("close", ""); };
  document.getElementById("propose").addEventListener("click", requestProposal);
  document.getElementById("apply").addEventListener("click", applySelected);
  document.getElementById("toggle").addEventListener("click", function () { var inputs = Array.from(document.querySelectorAll(".proposal input")); var next = inputs.some(function (input) { return !input.checked; }); inputs.forEach(function (input) { input.checked = next; }); });
})();
