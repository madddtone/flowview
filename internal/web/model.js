// Flow graph math shared with the Omarchy plugin's FlowModel.js.
// Keep the two files in sync; this copy is browser-safe (no `.pragma library`).
(function (global) {
  'use strict'

  function parseJSON(text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  function buildGraph(flow) {
    var nodes = (flow && flow.nodes) ? flow.nodes : []
    var edges = (flow && flow.edges) ? flow.edges : []
    var byId = {}
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      byId[n.id] = n
      var r = n.rect
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.w)
      maxY = Math.max(maxY, r.y + r.h)
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300 }
    return {
      flow: flow,
      nodes: nodes,
      edges: edges,
      byId: byId,
      bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY }
    }
  }

  function successors(edges, id) {
    var out = []
    for (var i = 0; i < edges.length; i++) if (edges[i].from === id) out.push(edges[i])
    return out
  }

  function predecessors(edges, id) {
    var out = []
    for (var i = 0; i < edges.length; i++) if (edges[i].to === id) out.push(edges[i])
    return out
  }

  function downstream(edges, id) {
    var nodes = {}, edgeSet = {}, stack = [id]
    while (stack.length > 0) {
      var u = stack.pop()
      var outs = successors(edges, u)
      for (var i = 0; i < outs.length; i++) {
        var e = outs[i]
        edgeSet[e.id] = true
        if (!nodes[e.to]) { nodes[e.to] = true; stack.push(e.to) }
      }
    }
    return { nodes: nodes, edges: edgeSet }
  }

  function ancestors(edges, id) {
    var nodes = {}, edgeSet = {}, stack = [id]
    while (stack.length > 0) {
      var u = stack.pop()
      var ins = predecessors(edges, u)
      for (var i = 0; i < ins.length; i++) {
        var e = ins[i]
        edgeSet[e.id] = true
        if (!nodes[e.from]) { nodes[e.from] = true; stack.push(e.from) }
      }
    }
    return { nodes: nodes, edges: edgeSet }
  }

  function edgeGeometry(s, t, back) {
    var sx = s.x, sy = s.y, sw = s.w, sh = s.h
    var tx = t.x, ty = t.y, tw = t.w, th = t.h

    if (back) {
      var bx1 = sx + sw / 2, by1 = sy + sh
      var bx2 = tx + tw / 2, by2 = ty + th
      var dip = Math.max(by1, by2) + 70
      return { x1: bx1, y1: by1, x2: bx2, y2: by2, c1x: bx1, c1y: dip, c2x: bx2, c2y: dip }
    }
    var overlapX = Math.min(sx + sw, tx + tw) > Math.max(sx, tx)
    var below = ty > sy + sh - 1
    if (below && overlapX) {
      var vx1 = sx + sw / 2, vy1 = sy + sh
      var vx2 = tx + tw / 2, vy2 = ty
      var my = (vy1 + vy2) / 2
      return { x1: vx1, y1: vy1, x2: vx2, y2: vy2, c1x: vx1, c1y: my, c2x: vx2, c2y: my }
    }
    var right = (tx + tw / 2) >= (sx + sw / 2)
    var hx1 = right ? sx + sw : sx
    var hy1 = sy + sh / 2
    var hx2 = right ? tx : tx + tw
    var hy2 = ty + th / 2
    var dx = hx2 - hx1
    var bend = Math.max(40, Math.abs(dx) * 0.5)
    return {
      x1: hx1, y1: hy1, x2: hx2, y2: hy2,
      c1x: hx1 + (right ? bend : -bend), c1y: hy1,
      c2x: hx2 - (right ? bend : -bend), c2y: hy2
    }
  }

  function arrow(geom, size) {
    var sx = geom.x1, sy = geom.y1, ex = geom.x2, ey = geom.y2
    var dx = ex - geom.c2x, dy = ey - geom.c2y
    var len = Math.sqrt(dx * dx + dy * dy)
    if (len < 0.001) { dx = ex - sx; dy = ey - sy; len = Math.sqrt(dx * dx + dy * dy) }
    if (len < 0.001) { dx = 1; dy = 0; len = 1 }
    var ux = dx / len, uy = dy / len
    var px = -uy, py = ux
    var s = size
    return {
      tipX: ex, tipY: ey,
      leftX: ex - ux * s + px * s * 0.5, leftY: ey - uy * s + py * s * 0.5,
      rightX: ex - ux * s - px * s * 0.5, rightY: ey - uy * s - py * s * 0.5
    }
  }

  function pathD(g) {
    return 'M' + g.x1 + ',' + g.y1 + ' C' + g.c1x + ',' + g.c1y + ' ' + g.c2x + ',' + g.c2y + ' ' + g.x2 + ',' + g.y2
  }

  function searchNodes(nodes, query) {
    var q = String(query || '').toLowerCase()
    if (!q) return []
    var out = []
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var cols = ''
      if (n.columns) for (var c = 0; c < n.columns.length; c++) cols += ' ' + n.columns[c].name
      var hay = (n.id + ' ' + (n.title || '') + ' ' + (n.actor || '') + ' ' + (n.tags ? n.tags.join(' ') : '') + cols).toLowerCase()
      if (hay.indexOf(q) >= 0) out.push(n)
    }
    return out
  }

  // displayColumns: up to max columns for a table node — keys first, then order.
  function displayColumns(cols, max) {
    max = max || 5
    if (!cols || cols.length === 0) return []
    if (cols.length <= max) return cols.slice(0)
    var keys = [], rest = []
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i]
      if (c.pk || c.fk) keys.push(c); else rest.push(c)
    }
    var out = keys.slice(0, max)
    for (var j = 0; j < rest.length && out.length < max; j++) out.push(rest[j])
    return out
  }

  global.FlowModel = {
    parseJSON: parseJSON, buildGraph: buildGraph,
    successors: successors, predecessors: predecessors,
    downstream: downstream, ancestors: ancestors,
    edgeGeometry: edgeGeometry, arrow: arrow, pathD: pathD,
    searchNodes: searchNodes, displayColumns: displayColumns
  }
})(window)
