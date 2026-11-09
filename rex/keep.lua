-- Pins or unpins the tab holding the focused block. pi-rex-subagents never closes a child tab
-- whose label differs from its launch label, so the pin keeps it. Bind it from init.lua:
--   dofile("/absolute/path/to/pi-rex-subagents/rex/keep.lua")
--   rex.bind("ctrl+shift+k", "subagents_keep")

local PIN = "📌 "

local function resolve(kind, id)
  local resolved, err = rex.call("target.resolve", {kinds = {kind}, queries = {id}})
  if not resolved then return nil, err end
  local result = (resolved.results or {})[1]
  if not result or result.status ~= "resolved" or type(result.target) ~= "table" then
    return nil
  end
  return result.target
end

local function keep(ctx)
  local block = ctx and ctx.block_id
  if not block then return {status = "error", error = "no focused block"} end
  local placed, err = resolve("block", block)
  if not placed then return {status = "error", error = tostring(err or "block not found")} end
  local window = resolve("window", placed.window_id)
  local label = (window and window.label) or ""
  local pinning = label:sub(1, #PIN) ~= PIN
  local next_label = pinning and (PIN .. label) or label:sub(#PIN + 1)
  local ok, set_err = rex.call("session.set_window_label", {
    session_id = placed.session_id,
    window_id = placed.window_id,
    label = next_label,
  })
  if not ok then return {status = "error", error = tostring(set_err)} end
  return {status = pinning and "kept" or "released", label = next_label}
end

rex.action{
  name = "subagents_keep",
  title = "Keep Subagent Tab",
  description = "Pin or unpin the focused tab so pi-rex-subagents does not close it",
  run = keep,
}

if rex.args then return rex.invoke("subagents_keep") end
