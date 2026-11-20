-- Jump to the oldest terminal waiting for user input across all Rex sessions.
-- Uses Rex's native OSC 7501 program_status directly (zero filesystem scraping).
--
-- Bind in Rex's init.lua:
--   dofile("/path/to/pi-rex-subagents/rex/next_waiting.lua")
--   rex.bind("ctrl+shift+n", "subagents_next_waiting")

local function collect_blocks(session_id)
  local blocks = {}
  local view = rex.call("session.view", {session_id = session_id})
  if view and type(view.windows) == "table" then
    for _, win in ipairs(view.windows) do
      for _, layer in ipairs(win.layers or {}) do
        for _, block in ipairs(layer.blocks or {}) do
          if block.creator_name == "com.superlogical.terminal" and block.block_id then
            blocks[#blocks + 1] = {
              session_id = session_id,
              window_id = win.window_id,
              block_id = block.block_id,
            }
          end
        end
      end
    end
  end
  local listed = rex.call("session.list_blocks", {session_id = session_id})
  if listed and type(listed.blocks) == "table" then
    local seen = {}
    for _, b in ipairs(blocks) do seen[b.block_id] = true end
    for _, block in ipairs(listed.blocks) do
      if block.creator_name == "com.superlogical.terminal" and block.block_id and not seen[block.block_id] then
        blocks[#blocks + 1] = {
          session_id = session_id,
          window_id = block.window_id,
          block_id = block.block_id,
        }
      end
    end
  end
  return blocks
end

local function oldest_blocked_ts(session_id, block_id)
  local status = rex.call("block.method", {
    session_id = session_id,
    block_id = block_id,
    method = "com.superlogical.terminal.program_status",
    args = {},
  })
  if not status or type(status.records) ~= "table" then return nil end
  local oldest = nil
  for _, rec in ipairs(status.records) do
    if rec.state == "blocked" and type(rec.updated_at) == "string" then
      if not oldest or rec.updated_at < oldest then oldest = rec.updated_at end
    end
  end
  return oldest
end

local function next_waiting(ctx)
  local anchor = (ctx and ctx.block_id) or (rex.args and rex.args.anchor)
  local listed, err = rex.call("session.list", {})
  if not listed then return {status = "error", error = tostring(err)} end

  local candidates = {}
  for _, s in ipairs(listed.sessions or {}) do
    for _, b in ipairs(collect_blocks(s.session_id)) do
      local since = oldest_blocked_ts(b.session_id, b.block_id)
      if since then
        b.since = since
        candidates[#candidates + 1] = b
      end
    end
  end
  table.sort(candidates, function(a, b)
    if a.since == b.since then return a.block_id < b.block_id end
    return a.since < b.since
  end)
  if #candidates == 0 then return {status = "no_waiting"} end

  local ok, attach_err = rex.call("session.attach_all", {event_scope = "session"})
  if not ok then return {status = "error", error = tostring(attach_err)} end

  for _, target in ipairs(candidates) do
    local win = target.window_id
    if not win and anchor then
      local moved = rex.call("session.move_block", {
        session_id = target.session_id,
        block_id = target.block_id,
        anchor_block_id = anchor,
      })
      if moved then
        local resolved = rex.call("target.resolve", {kinds = {"block"}, queries = {target.block_id}})
        local first = resolved and resolved.results and resolved.results[1]
        win = first and first.target and first.target.window_id or nil
      end
    end
    if win then
      rex.session.focus_block{session_id = target.session_id, block_id = target.block_id}
      rex.client.queue("session.select", {session_id = target.session_id, window_id = win})
      return {
        status = "selected",
        sessionId = target.session_id,
        windowId = win,
        blockId = target.block_id,
      }
    end
  end
  return {status = "no_waiting"}
end

rex.action{
  name = "subagents_next_waiting",
  title = "Next Waiting Terminal",
  description = "Jump to the oldest blocked terminal across all Rex sessions",
  run = next_waiting,
}

if rex.args then return rex.invoke("subagents_next_waiting") end
