-- Also loadable with dofile from init.lua: registration alone does not navigate.
-- A rex do connection attached with -s cannot call session methods on any other
-- session (409). target.resolve finds a block by its stable ID across sessions,
-- and session.attach_all allows focus_block without joining those sessions.

local function read_json(path)
  local file = io.open(path, "r")
  if not file then return nil end
  local raw = file:read("*a")
  file:close()
  local ok, value = pcall(rex.json.decode, raw)
  if not ok then return nil end
  return value
end

local function state_dir()
  local state = os.getenv("PI_SUBAGENTS_STATE_DIR")
  if state == nil or state == "" then
    local agent = os.getenv("PI_CODING_AGENT_DIR")
    if agent == nil or agent == "" then
      agent = (os.getenv("HOME") or "") .. "/.pi/agent"
    end
    state = agent .. "/subagents"
  end
  if state:sub(1, 2) == "~/" then
    state = (os.getenv("HOME") or "") .. state:sub(2)
  end
  return state
end

local function reservation_paths(dir)
  local listed, err = rex.exec(
    {"find", dir, "-maxdepth", "1", "-name", "*.json", "-type", "f"},
    {timeout = 5}
  )
  if not listed then return nil, err end
  if not listed.ok then
    local probe = rex.exec({"find", dir, "-maxdepth", "0", "-type", "d"}, {timeout = 5})
    if not probe or not probe.ok then return {} end
    return nil, listed.stderr
  end
  local paths = {}
  for path in listed.stdout:gmatch("[^\r\n]+") do
    paths[#paths + 1] = path
  end
  return paths
end

local function is_waiting(run)
  return type(run) == "table"
    and run.version == 1
    and type(run.waiting) == "table"
    and type(run.waiting.since) == "number"
    and type(run.rex) == "table"
    and type(run.rex.blockId) == "string"
    and type(run.process) == "table"
    and run.process.state ~= "exited"
    and not run.finishedAt
end

local function placed(block_id)
  local resolved, err = rex.call("target.resolve", {kinds = {"block"}, queries = {block_id}})
  if not resolved then return nil, err end
  local result = (resolved.results or {})[1]
  if not result or result.status ~= "resolved" or type(result.target) ~= "table" then
    return nil
  end
  local target = result.target
  if target.kind ~= "block" or not target.session_id or not target.window_id or not target.block_id then
    return nil
  end
  return target
end

local function next_waiting()
  local state = state_dir()
  local paths, err = reservation_paths(state .. "/reservations")
  if not paths then return {status = "error", error = tostring(err)} end
  local candidates, seen, count = {}, {}, 0
  for _, path in ipairs(paths) do
    local reservation = read_json(path)
    local members = type(reservation) == "table" and reservation.members or {}
    for _, member in ipairs(members) do
      local id = type(member) == "table" and member.runId or nil
      if type(id) == "string" and #id == 24 and id:match("^[a-f0-9]+$") and not seen[id] then
        seen[id] = true
        count = count + 1
        local run = read_json(state .. "/runs/" .. id .. "/run.json")
        if is_waiting(run) then candidates[#candidates + 1] = run end
      end
    end
  end
  table.sort(candidates, function(a, b)
    if a.waiting.since == b.waiting.since then return a.id < b.id end
    return a.waiting.since < b.waiting.since
  end)
  if #candidates == 0 then return {status = "no_waiting", recordsRead = count} end
  local attached = false
  for _, run in ipairs(candidates) do
    local target, resolve_err = placed(run.rex.blockId)
    if resolve_err then return {status = "error", error = tostring(resolve_err), recordsRead = count} end
    if target then
      if not attached then
        local ok, attach_err = rex.call("session.attach_all", {event_scope = "session"})
        if not ok then return {status = "error", error = tostring(attach_err), recordsRead = count} end
        attached = true
      end
      local focused, focus_err = rex.session.focus_block{
        session_id = target.session_id,
        block_id = target.block_id,
      }
      if not focused then
        return {status = "error", error = tostring(focus_err), recordsRead = count}
      end
      rex.client.queue("session.select", {
        session_id = target.session_id,
        window_id = target.window_id,
      })
      return {
        status = "selected",
        runId = run.id,
        sessionId = target.session_id,
        windowId = target.window_id,
        blockId = target.block_id,
        recordsRead = count,
      }
    end
  end
  return {status = "no_waiting", recordsRead = count}
end

rex.action{
  name = "subagents_next_waiting",
  title = "Next Waiting Subagent",
  description = "Go to the oldest child waiting for a human, across every parent",
  run = next_waiting,
}

-- rex.args is nil in init.lua and a table, possibly empty, under rex do.
if rex.args then return rex.invoke("subagents_next_waiting") end
