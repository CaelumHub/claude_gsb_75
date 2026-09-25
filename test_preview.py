#!/usr/bin/env python3
"""End-to-end check of the template deploy-preview capability."""
import os
import shutil
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.config import build_config
from backend.node import Node
from backend.server import create_app
from backend.templates import get_template

tmp = tempfile.mkdtemp(prefix="lc_preview_test_")
args = types.SimpleNamespace(id="t1", port=9999, host="127.0.0.1",
                             peers=None, data_dir=tmp, mine=False,
                             seed=False, mining_interval=None)
cfg = build_config(args)
cfg["mine"] = False
node = Node(cfg)
node.start()
app = create_app(node)
client = app.test_client()

failures = []


def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), "-", name, extra)
    if not cond:
        failures.append(name)


# Wallet for sender
r = client.post("/api/wallet/create", json={"label": "alice"})
sender = r.get_json()["address"]

token_src = get_template("token")["source"]

# --- 1. valid preview -------------------------------------------------------
root_before = node.blockchain.state.root()
r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": ["MyToken", "MT", 1000],
    "sender": sender, "fee": 0})
d = r.get_json()
check("preview ok", r.status_code == 200 and d["ok"] is True, str(d.get("error")))
check("preview flagged", d.get("preview") is True)
check("preview height", d.get("height") == node.blockchain.height + 1)
st = d.get("storage", {})
check("storage name", st.get("name") == "MyToken")
check("storage symbol", st.get("symbol") == "MT")
check("storage supply", st.get("total_supply") == 1000)
check("storage balance", st.get("bal_" + sender) == 1000)
ev = d.get("events", [])
check("mint event", len(ev) == 1 and ev[0]["event"] == "Minted"
      and ev[0]["data"]["amount"] == 1000, str(ev))
check("no transfers", d.get("transfers") == [])
check("state untouched", node.blockchain.state.root() == root_before)
check("no contracts created", len(node.blockchain.state.contracts) == 0)

# --- 2. repeatable preview with adjusted params ------------------------------
r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": ["Other", "OT", 42], "sender": sender})
d2 = r.get_json()
check("re-preview ok", d2["ok"] and d2["storage"]["total_supply"] == 42)
check("re-preview independent", d2["storage"]["name"] == "Other"
      and st.get("name") == "MyToken")
check("state still untouched", node.blockchain.state.root() == root_before)

# --- 3. invalid params are caught at preview time ----------------------------
r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": ["OnlyName"], "sender": sender})
d = r.get_json()
check("wrong arg count fails", d["ok"] is False and "init" in (d["error"] or "")
      or "argument" in (d["error"] or ""), str(d.get("error")))

bad_src = 'def init(supply):\n    require(supply > 0, "发行量必须为正")\n    state["s"] = supply\n'
r = client.post("/api/contract/simulate_deploy", json={
    "code": bad_src, "constructor": [-5], "sender": sender})
d = r.get_json()
check("require failure surfaced", d["ok"] is False
      and "发行量必须为正" in (d["error"] or ""), str(d.get("error")))

r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": {"a": 1}, "sender": sender})
check("non-array ctor rejected", r.status_code == 400
      and r.get_json()["ok"] is False)

r = client.post("/api/contract/simulate_deploy", json={
    "code": "def init():\n    state['x'] = 1\n", "constructor": [],
    "sender": sender, "fee": 1e9})
d = r.get_json()
check("unaffordable fee flagged", d["ok"] is False and "余额不足" in d["error"],
      str(d.get("error")))

r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": ["NoWallet", "NW", 7]})
d = r.get_json()
check("preview works without wallet", d["ok"] is True
      and d["storage"].get("total_supply") == 7
      and d["storage"].get("bal_" + "0x" + "0" * 40) == 7)

# --- 4. real deploy matches the last preview exactly -------------------------
ctor = ["MyToken", "MT", 1000]
r = client.post("/api/contract/simulate_deploy", json={
    "code": token_src, "constructor": ctor, "sender": sender, "fee": 0})
preview = r.get_json()
check("final preview ok", preview["ok"] is True)

r = client.post("/api/contract/deploy", json={
    "sender": sender, "code": token_src, "constructor": ctor, "fee": 0})
dep = r.get_json()
check("deploy tx accepted", dep["ok"] is True, str(dep))
addr = dep["address"]
status, msg, height = node.mine_block(sender)
check("block mined", status == "extended", msg)

r = client.get("/api/contract/" + addr)
onchain = r.get_json()
check("deployed storage == preview storage",
      onchain["storage"] == preview["storage"],
      f"\n  onchain={onchain['storage']}\n  preview={preview['storage']}")
check("deployed events == preview events",
      [e["event"] for e in onchain["events"]] ==
      [e["event"] for e in preview["events"]], str(onchain["events"]))

# --- 5. existing flows unaffected --------------------------------------------
r = client.get("/api/templates")
check("template catalog intact", r.status_code == 200
      and len(r.get_json()["templates"]) >= 7)
r = client.get("/api/templates/token")
check("template detail intact", r.get_json()["template"]["name"] == "token")
r = client.post("/api/contract/validate", json={"code": token_src})
check("validate endpoint intact", r.get_json()["ok"] is True)

shutil.rmtree(tmp, ignore_errors=True)
print()
if failures:
    print("FAILURES:", failures)
    sys.exit(1)
print("ALL CHECKS PASSED")
