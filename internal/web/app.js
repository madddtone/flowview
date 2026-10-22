// Flow Viewer frontend. Reads compiled flow.json from the Go server and
// mirrors the Omarchy overlay: trace routes, inspect nodes, drill into
// subflows, pan/zoom, drag nodes.
(function () {
  'use strict'
  var FM = window.FlowModel
  var SVGNS = 'http://www.w3.org/2000/svg'
  var $ = function (id) { return document.getElementById(id) }

  var state = {
    projects: [],
    rootJsonPath: '',
    curPath: '',
    viewTitle: '',
    navStack: [],
    graph: null,
    selectedId: '',
    mode: 'successors',
    hlNodes: {}, hlEdges: {}, upNodes: {},
    zoom: 1, panX: 40, panY: 40,
    posOverrides: {},
    edgeRecs: {}, nodeEls: {},
    searchOpen: false, searchResults: [], searchIndex: 0,
    projectsOpen: false, projectsIndex: 0
  }

  // ------------------------------------------------------------------ utils
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  function mdToHtml(s) {
    var lines = String(s || '').split('\n')
    var out = [], inList = false
    function closeList() { if (inList) { out.push('</ul>'); inList = false } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var m = line.match(/^\s*[-*]\s+(.*)$/)
      if (m) {
        if (!inList) { out.push('<ul>'); inList = true }
        out.push('<li>' + inline(m[1]) + '</li>')
      } else if (line.trim() === '') {
        closeList()
      } else {
        closeList()
        out.push('<div>' + inline(line) + '</div>')
      }
    }
    closeList()
    return out.join('')
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  }
  function isTerminal(n) { return n.type === 'start' || n.type === 'end' }
  function hasSubflow(n) { return !!(n.subflow || n.subflowJson) }
  function metaText(n) {
    var a = n.actor || '', c = n.code || ''
    if (a && c) return a + '  ·  ' + c
    return a || c
  }
  function resolveSubflow(node) {
    var rel = null
    if (node.subflow) rel = node.subflow
    else if (node.subflowJson) rel = String(node.subflowJson).split('/').pop()
    if (!rel) return null
    var dir = state.curPath.replace(/\/[^/]*$/, '')
    return normalizePath(dir + '/' + rel).replace(/\.md$/i, '.json')
  }
  function normalizePath(p) {
    var parts = String(p).split('/'), out = []
    for (var i = 0; i < parts.length; i++) {
      var x = parts[i]
      if (x === '' || x === '.') continue
      if (x === '..') out.pop(); else out.push(x)
    }
    return out.join('/')
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status)
      return r.json()
    })
  }

  // -------------------------------------------------------------- positions
  function effRect(id) {
    var n = state.graph && state.graph.byId[id]
    if (!n) return null
    var o = state.posOverrides[id]
    return { x: o ? o.x : n.rect.x, y: o ? o.y : n.rect.y, w: n.rect.w, h: n.rect.h }
  }
  function effBounds() {
    var ns = state.graph ? state.graph.nodes : []
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (var i = 0; i < ns.length; i++) {
      var r = effRect(ns[i].id)
      if (!r) continue
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h)
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, width: 800, height: 600 }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY }
  }
  function dragNode(id, dxWorld, dyWorld) {
    var n = state.graph.byId[id]
    if (!n) return
    var o = state.posOverrides[id]
    state.posOverrides[id] = {
      x: (o ? o.x : n.rect.x) + dxWorld,
      y: (o ? o.y : n.rect.y) + dyWorld
    }
  }

  // ------------------------------------------------------------------ grow
  function boot() {
    applyTheme(localStorage.getItem('flowview-theme') || 'dark')
    wireEvents()
    fetchJSON('/api/index').then(function (idx) {
      state.projects = (idx && idx.projects) || []
      $('projectsCount').textContent = state.projects.length
      if (state.projects.length === 0) {
        showEmpty('No flows found', 'Point flowview at a folder that contains flow JSON\n(or the flowc store: ~/.local/share/flow-tracker).')
        return
      }
      var params = new URLSearchParams(location.search)
      var want = params.get('p')
      state.wantNode = params.get('node')
      var chosen = want ? state.projects.find(function (p) { return p.jsonPath === want || p.id === want }) : null
      var load = loadProject(chosen || state.projects[0])
      if (new URLSearchParams(location.search).get('preview') === '1')
        load.then(function () { setTimeout(exportPng, 300) })
    }).catch(function (e) {
      showEmpty('Cannot load flows', String(e.message || e))
    })
  }

  function showEmpty(title, hint) {
    $('empty').classList.remove('hidden')
    $('emptyTitle').textContent = title
    $('emptyHint').textContent = hint || ''
  }
  function hideEmpty() { $('empty').classList.add('hidden') }

  function loadProject(p) {
    state.rootJsonPath = p.jsonPath
    state.navStack = []
    state.viewTitle = p.name || p.id
    state.posOverrides = {}
    state.selectedId = ''
    $('title').textContent = p.name || p.id
    $('repo').textContent = p.repo || ''
    $('inspector').classList.add('hidden')
    return loadFlow(p.jsonPath)
  }

  function loadFlow(path, keepTitle) {
    return fetchJSON('/api/flow?path=' + encodeURIComponent(path)).then(function (doc) {
      state.curPath = path
      state.graph = FM.buildGraph(doc)
      state.selectedId = ''
      state.posOverrides = {}
      $('modeChip').classList.add('hidden')
      render()
      fit()
      hideEmpty()
      if (state.wantNode && state.graph.byId[state.wantNode]) {
        jumpTo(state.wantNode)
        state.wantNode = null
      }
    }).catch(function (e) {
      showEmpty('Cannot load flow', String(e.message || e))
    })
  }

  function enterSubflow(id) {
    var n = state.graph.byId[id]
    var target = resolveSubflow(n)
    if (!target) return
    state.navStack.push({ path: state.curPath, title: state.viewTitle || $('title').textContent })
    state.viewTitle = n.subflowName || n.title || n.id
    loadFlow(target)
    renderBreadcrumb()
  }
  function goBack() {
    if (state.navStack.length === 0) return false
    var e = state.navStack.pop()
    state.viewTitle = e.title
    loadFlow(e.path)
    renderBreadcrumb()
    return true
  }
  function goToCrumb(depth) {
    if (depth >= state.navStack.length) return
    var last = state.navStack[depth]
    state.navStack = state.navStack.slice(0, depth)
    state.viewTitle = last.title
    loadFlow(last.path)
    renderBreadcrumb()
  }

  // -------------------------------------------------------------- rendering
  function render() {
    var g = state.graph
    var svg = $('edges'); svg.innerHTML = ''
    var layer = $('nodesLayer'); layer.innerHTML = ''
    state.edgeRecs = {}; state.nodeEls = {}

    for (var i = 0; i < g.edges.length; i++) {
      var e = g.edges[i]
      var rec = buildEdgeEl()
      rec.g.dataset.id = e.id
      state.edgeRecs[e.id] = rec
      svg.appendChild(rec.g)
      updateEdge(rec, e)
    }
    for (var j = 0; j < g.nodes.length; j++) {
      var n = g.nodes[j]
      var div = buildNodeEl(n)
      state.nodeEls[n.id] = div
      layer.appendChild(div)
      positionNode(n.id)
    }
    applyTransform()
    applyHighlight()
    renderBreadcrumb()
    $('stats').textContent = g.nodes.length + ' nodes · ' + g.edges.length + ' edges'
  }

  function buildEdgeEl() {
    var g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'edge')
    var line = document.createElementNS(SVGNS, 'path'); line.setAttribute('class', 'line')
    var arrow = document.createElementNS(SVGNS, 'polygon'); arrow.setAttribute('class', 'arrowhead')
    var label = document.createElementNS(SVGNS, 'text'); label.setAttribute('class', 'label')
    label.style.display = 'none'
    g.appendChild(line); g.appendChild(arrow); g.appendChild(label)
    return { g: g, line: line, arrow: arrow, label: label }
  }
  function updateEdge(rec, e) {
    var s = effRect(e.from), t = effRect(e.to)
    if (!s || !t) return
    var geom = FM.edgeGeometry(s, t, e.back === true)
    rec.line.setAttribute('d', FM.pathD(geom))
    var a = FM.arrow(geom, 11)
    rec.arrow.setAttribute('points', a.tipX + ',' + a.tipY + ' ' + a.leftX + ',' + a.leftY + ' ' + a.rightX + ',' + a.rightY)
    var txt = (e.label && e.label.length) ? e.label : (e.when ? 'when ' + e.when : '')
    rec.label.textContent = txt
    rec.label.setAttribute('x', (geom.c1x + geom.c2x) / 2)
    rec.label.setAttribute('y', (geom.c1y + geom.c2y) / 2)
    rec.label.setAttribute('text-anchor', 'middle')
  }

  function buildNodeEl(n) {
    var div = document.createElement('div')
    div.className = 'node type-' + n.type + (isTerminal(n) ? ' terminal' : '') + (n.type === 'decision' ? ' decision' : '') + (n.type === 'table' ? ' table' : '')
    div.dataset.id = n.id
    div.style.width = n.rect.w + 'px'
    div.style.height = n.rect.h + 'px'

    if (n.type === 'table') return buildTableEl(div, n)

    var shape = document.createElement('div')
    shape.className = n.type === 'decision' ? 'diamond' : 'card'
    var stripe = document.createElement('div'); stripe.className = 'stripe'
    var content = document.createElement('div'); content.className = 'content'
    var title = document.createElement('div'); title.className = 'title'; title.textContent = n.title || n.id
    var idEl = document.createElement('div'); idEl.className = 'id'; idEl.textContent = n.id
    content.appendChild(title); content.appendChild(idEl)

    if (n.type !== 'decision') {
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = metaText(n)
      content.appendChild(meta)
      if (hasSubflow(n)) {
        var sf = document.createElement('div'); sf.className = 'subflow'
        sf.textContent = '\u21b3 open subflow · ' + (n.subflowNodes || 0)
        content.appendChild(sf)
      }
    }
    div.appendChild(shape); div.appendChild(stripe); div.appendChild(content)

    var hover = document.createElement('div'); hover.className = 'hoverArea'
    div.appendChild(hover)
    wireNode(n, div, hover)
    return div
  }

  function buildTableEl(div, n) {
    var card = document.createElement('div'); card.className = 'card'
    var head = document.createElement('div'); head.className = 'thead'
    var name = document.createElement('span'); name.className = 'tname'; name.textContent = n.title || n.id
    head.appendChild(name)
    if (n.schema) { var sc = document.createElement('span'); sc.className = 'tschema'; sc.textContent = n.schema; head.appendChild(sc) }
    card.appendChild(head)

    var cols = FM.displayColumns(n.columns, 5)
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i]
      var row = document.createElement('div'); row.className = 'trow'
      var cn = document.createElement('span'); cn.className = 'tcol'; cn.textContent = c.name
      row.appendChild(cn)
      var right = document.createElement('span'); right.className = 'tright'
      if (c.pk) { var pk = document.createElement('span'); pk.className = 'badge'; pk.textContent = 'PK'; right.appendChild(pk) }
      if (c.fk) { var fk = document.createElement('span'); fk.className = 'badge'; fk.textContent = 'FK'; right.appendChild(fk) }
      if (c.type) { var ty = document.createElement('span'); ty.className = 'ttype'; ty.textContent = c.type; right.appendChild(ty) }
      row.appendChild(right)
      card.appendChild(row)
    }
    var total = n.columns ? n.columns.length : 0
    if (total > cols.length) {
      var hid = total - cols.length
      var more = document.createElement('div'); more.className = 'tmore'
      more.textContent = '+' + hid + ' more column' + (hid === 1 ? '' : 's') + ' (see details)'
      card.appendChild(more)
    }
    div.appendChild(card)
    var hover = document.createElement('div'); hover.className = 'hoverArea'
    div.appendChild(hover)
    wireNode(n, div, hover)
    return div
  }

  function positionNode(id) {
    var div = state.nodeEls[id]; var r = effRect(id)
    if (!div || !r) return
    div.style.left = r.x + 'px'
    div.style.top = r.y + 'px'
  }

  // ------------------------------------------------------------- highlight
  function nodeLevel(id) {
    if (id === state.selectedId) return 'selected'
    if (state.upNodes[id]) return 'ancestor'
    if (state.hlNodes[id]) return state.mode === 'downstream' ? 'downstream' : 'successor'
    return 'normal'
  }
  function edgeLevel(e) {
    if (!state.selectedId) return 'normal'
    if (state.hlEdges[e.id]) return 'hot'
    if (state.upNodes[e.from] && (e.to === state.selectedId || state.upNodes[e.to])) return 'up'
    return 'dim'
  }
  function applyHighlight() {
    var g = state.graph
    if (!g) return
    for (var id in state.nodeEls) {
      var div = state.nodeEls[id]
      div.classList.remove('selected', 'successor', 'downstream', 'ancestor', 'dim')
      var lvl = nodeLevel(id)
      if (lvl !== 'normal') div.classList.add(lvl)
      if (state.selectedId && lvl === 'normal') div.classList.add('dim')
    }
    for (var i = 0; i < g.edges.length; i++) {
      var e = g.edges[i]
      var rec = state.edgeRecs[e.id]
      if (!rec) continue
      rec.g.classList.remove('hot', 'up', 'dim')
      var l = edgeLevel(e)
      if (l !== 'normal') rec.g.classList.add(l)
      rec.label.style.display = (l === 'hot' || l === 'up') ? '' : 'none'
    }
    if (state.selectedId) {
      $('modeChip').textContent = state.mode === 'downstream' ? 'downstream (d)' : 'next steps (d)'
      $('modeChip').classList.remove('hidden')
    } else {
      $('modeChip').classList.add('hidden')
    }
  }
  function updateHighlight() {
    if (!state.selectedId) { state.hlNodes = {}; state.hlEdges = {}; state.upNodes = {} }
    else {
      var succ = state.mode === 'downstream'
        ? FM.downstream(state.graph.edges, state.selectedId)
        : (function () {
            var es = FM.successors(state.graph.edges, state.selectedId)
            var ns = {}, hs = {}
            for (var i = 0; i < es.length; i++) { hs[es[i].id] = true; ns[es[i].to] = true }
            return { nodes: ns, edges: hs }
          })()
      var anc = FM.ancestors(state.graph.edges, state.selectedId)
      state.hlNodes = succ.nodes; state.hlEdges = succ.edges; state.upNodes = anc.nodes
    }
    applyHighlight()
  }
  function selectNode(id) {
    state.selectedId = id
    updateHighlight()
    renderInspector()
  }
  function clearSelection() {
    state.selectedId = ''
    updateHighlight()
    $('inspector').classList.add('hidden')
  }
  function toggleMode() {
    state.mode = state.mode === 'successors' ? 'downstream' : 'successors'
    updateHighlight()
  }
  function jumpTo(id) {
    if (!state.graph.byId[id]) return
    selectNode(id)
    centerOn(id)
  }
  function stepTo(dir) {
    if (!state.selectedId) return
    var list = dir > 0 ? FM.successors(state.graph.edges, state.selectedId) : FM.predecessors(state.graph.edges, state.selectedId)
    if (list.length === 0) return
    jumpTo(dir > 0 ? list[0].to : list[0].from)
  }

  // -------------------------------------------------------------- inspector
  function titleCase(s) {
    return String(s || '').split(' ').map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w }).join(' ')
  }
  function renderInspector() {
    var n = state.graph && state.graph.byId[state.selectedId]
    var box = $('inspector')
    if (!n) { box.classList.add('hidden'); return }
    var h = []
    h.push('<div class="head"><h2>' + esc(n.title || n.id) + '</h2><button class="close" id="inspClose">\u2715</button></div>')
    h.push('<div class="badge">' + esc(n.type) + '</div> <span class="muted">' + esc(n.id) + '</span>')
    if (hasSubflow(n)) {
      var target = resolveSubflow(n)
      h.push('<button class="openSub" id="openSubBtn">Open subflow \u2192 ' + esc(n.subflowName || '') + (n.subflowNodes ? '  (' + n.subflowNodes + ' nodes)' : '') + '</button>')
    }
    var rows = []
    if (n.actor) rows.push(['Actor', n.actor])
    if (n.owner) rows.push(['Owner', n.owner])
    if (n.status) rows.push(['Status', n.status])
    if (n.priority) rows.push(['Priority', n.priority])
    if (n.code) rows.push(['Code', n.code])
    if (n.tags && n.tags.length) rows.push(['Tags', n.tags.join(', ')])
    if (n.subflow) rows.push(['Subflow', n.subflow])
    for (var i = 0; i < rows.length; i++)
      h.push('<div class="row"><div class="k">' + esc(rows[i][0]) + '</div><div class="v">' + esc(rows[i][1]) + '</div></div>')
    if (n.columns && n.columns.length) {
      h.push('<div class="secLabel">Columns <span class="muted">(' + n.columns.length + ')</span></div>')
      h.push('<table class="cols"><tbody>')
      for (var c = 0; c < n.columns.length; c++) {
        var col = n.columns[c]
        var marks = (col.pk ? '<span class="tbadge">PK</span>' : '') +
          (col.fk ? '<span class="tbadge">FK ' + esc(col.fk) + '</span>' : '') +
          (col.nullable === false ? '<span class="tbadge mut">NOT NULL</span>' : '')
        h.push('<tr><td class="cname">' + esc(col.name) + '</td><td class="ctype">' + esc(col.type || '') + '</td><td class="cmark">' + marks + '</td></tr>')
      }
      h.push('</tbody></table>')
    }
    var order = n.sectionOrder || []
    if (order.length) {
      h.push('<hr>')
      for (var s = 0; s < order.length; s++) {
        var key = order[s]
        h.push('<div class="secLabel">' + esc(titleCase(key)) + '</div><div class="secBody">' + mdToHtml(n.sections[key]) + '</div>')
      }
    }
    var outs = FM.successors(state.graph.edges, n.id)
    if (outs.length) {
      h.push('<hr><div class="secLabel">Routes</div>')
      for (var o = 0; o < outs.length; o++) {
        var e = outs[o]
        h.push('<div class="route" data-to="' + esc(e.to) + '">\u2192 <b>' + esc(e.to) + '</b>' +
          (e.when ? '<span class="when">when ' + esc(e.when) + '</span>' : '') + '</div>')
      }
    }
    box.innerHTML = h.join('')
    box.classList.remove('hidden')
    var ic = $('inspClose'); if (ic) ic.onclick = clearSelection
    var ob = $('openSubBtn'); if (ob) ob.onclick = function () { enterSubflow(n.id) }
    var routes = box.querySelectorAll('.route')
    for (var r = 0; r < routes.length; r++)
      routes[r].onclick = (function (to) { return function () { jumpTo(to) } })(routes[r].dataset.to)
  }

  // --------------------------------------------------------------- viewport
  function usableWidth() {
    var w = $('viewport').clientWidth
    return $('inspector').classList.contains('hidden') ? w : w - 380
  }
  function applyTransform() {
    $('world').style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')'
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function zoomAt(factor, cx, cy) {
    var old = state.zoom
    var next = clamp(old * factor, 0.12, 4)
    if (next === old) return
    var wx = (cx - state.panX) / old, wy = (cy - state.panY) / old
    state.zoom = next
    state.panX = cx - wx * next
    state.panY = cy - wy * next
    applyTransform()
  }
  function fit() {
    var b = effBounds()
    var vw = usableWidth(), vh = $('viewport').clientHeight
    if (vw <= 0 || vh <= 0) return
    var pad = 90
    var z = clamp(Math.min((vw - 2 * pad) / b.width, (vh - 2 * pad) / b.height), 0.15, 1.35)
    state.zoom = z
    state.panX = (vw - b.width * z) / 2 - b.minX * z
    state.panY = (vh - b.height * z) / 2 - b.minY * z
    applyTransform()
  }
  function centerOn(id) {
    var r = effRect(id); if (!r) return
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2
    state.panX = usableWidth() / 2 - cx * state.zoom
    state.panY = $('viewport').clientHeight / 2 - cy * state.zoom
    applyTransform()
  }
  function resetView() {
    var b = effBounds()
    state.zoom = 1
    state.panX = 40 - b.minX
    state.panY = 40 - b.minY
    applyTransform()
  }
  function resetPositions() {
    state.posOverrides = {}
    for (var id in state.nodeEls) positionNode(id)
    for (var i = 0; i < state.graph.edges.length; i++) {
      var e = state.graph.edges[i]; updateEdge(state.edgeRecs[e.id], e)
    }
    fit()
  }

  // ----------------------------------------------------------- interactions
  function wireNode(n, div, hover) {
    var drag = null
    hover.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      ev.stopPropagation()
      hover.setPointerCapture(ev.pointerId)
      drag = { moved: false, last: { x: ev.clientX, y: ev.clientY } }
    })
    hover.addEventListener('pointermove', function (ev) {
      if (!drag) return
      var dx = ev.clientX - drag.last.x, dy = ev.clientY - drag.last.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      if (drag.moved) {
        dragNode(n.id, dx / state.zoom, dy / state.zoom)
        positionNode(n.id)
        refreshEdgesFor(n.id)
      }
      drag.last = { x: ev.clientX, y: ev.clientY }
    })
    hover.addEventListener('pointerup', function (ev) {
      if (!drag) return
      var moved = drag.moved; drag = null
      try { hover.releasePointerCapture(ev.pointerId) } catch (e) {}
      if (!moved) selectNode(n.id)
    })
    hover.addEventListener('dblclick', function (ev) {
      ev.stopPropagation()
      if (hasSubflow(n)) enterSubflow(n.id)
    })
  }
  function refreshEdgesFor(id) {
    var es = state.graph.edges
    for (var i = 0; i < es.length; i++) {
      if (es[i].from === id || es[i].to === id) updateEdge(state.edgeRecs[es[i].id], es[i])
    }
  }

  function wireEvents() {
    var vp = $('viewport')
    // pan the background
    var pan = null
    vp.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      if (ev.target.closest('.node')) return
      pan = { moved: false, x: ev.clientX, y: ev.clientY }
      vp.classList.add('panning')
      vp.setPointerCapture(ev.pointerId)
    })
    vp.addEventListener('pointermove', function (ev) {
      if (!pan) return
      var dx = ev.clientX - pan.x, dy = ev.clientY - pan.y
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true
      state.panX += dx; state.panY += dy
      pan.x = ev.clientX; pan.y = ev.clientY
      applyTransform()
    })
    vp.addEventListener('pointerup', function (ev) {
      if (!pan) return
      var moved = pan.moved; pan = null
      vp.classList.remove('panning')
      try { vp.releasePointerCapture(ev.pointerId) } catch (e) {}
      if (!moved) clearSelection()
    })
    vp.addEventListener('wheel', function (ev) {
      ev.preventDefault()
      var rect = vp.getBoundingClientRect()
      zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - rect.left, ev.clientY - rect.top)
    }, { passive: false })

    $('projectsBtn').onclick = openProjects
    $('findBtn').onclick = openSearch
    $('themeBtn').onclick = toggleTheme
    $('exportBtn').onclick = exportPng

    var si = $('searchInput')
    si.addEventListener('input', function () { runSearch(si.value) })
    si.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { searchMove(1); ev.preventDefault() }
      else if (ev.key === 'ArrowUp') { searchMove(-1); ev.preventDefault() }
      else if (ev.key === 'Enter') { acceptSearch(); ev.preventDefault() }
      else if (ev.key === 'Escape') { closeSearch(); ev.preventDefault() }
    })

    document.addEventListener('keydown', onKey)
  }

  function onKey(ev) {
    var tag = (ev.target && ev.target.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    switch (ev.key) {
      case 'Escape':
        if (state.searchOpen) return closeSearch()
        if (state.projectsOpen) return closeProjects()
        if (state.selectedId) return clearSelection()
        if (state.navStack.length) return void goBack()
        break
      case 'Backspace':
        if (goBack()) ev.preventDefault()
        break
      case 'Enter':
        if (state.selectedId && hasSubflow(state.graph.byId[state.selectedId])) enterSubflow(state.selectedId)
        break
      case 'q': dismissWindow(); break
      case 'p': openProjects(); break
      case '/': openSearch(); ev.preventDefault(); break
      case 'd': toggleMode(); break
      case 'f': fit(); break
      case 'r': resetPositions(); break
      case '0': resetView(); break
      case '+': case '=': zoomAt(1.15, usableWidth() / 2, $('viewport').clientHeight / 2); break
      case '-': zoomAt(1 / 1.15, usableWidth() / 2, $('viewport').clientHeight / 2); break
      case 'ArrowRight': case 'ArrowDown': if (state.selectedId) { stepTo(1); ev.preventDefault() } break
      case 'ArrowLeft': case 'ArrowUp': if (state.selectedId) { stepTo(-1); ev.preventDefault() } break
    }
  }
  function dismissWindow() { try { window.close() } catch (e) {} }

  // ---------------------------------------------------------------- search
  function openSearch() {
    state.searchOpen = true
    state.searchIndex = 0
    $('searchWrap').classList.remove('hidden')
    var si = $('searchInput'); si.value = ''
    runSearch('')
    setTimeout(function () { si.focus() }, 0)
  }
  function closeSearch() { state.searchOpen = false; $('searchWrap').classList.add('hidden') }
  function runSearch(q) {
    state.searchResults = FM.searchNodes(state.graph.nodes, q)
    if (state.searchIndex >= state.searchResults.length) state.searchIndex = 0
    renderSearchResults()
  }
  function searchMove(d) {
    if (!state.searchResults.length) return
    state.searchIndex = (state.searchIndex + d + state.searchResults.length) % state.searchResults.length
    renderSearchResults()
  }
  function acceptSearch() {
    if (state.searchResults.length) jumpTo(state.searchResults[state.searchIndex].id)
    closeSearch()
  }
  function renderSearchResults() {
    var box = $('searchResults')
    var h = []
    for (var i = 0; i < state.searchResults.length; i++) {
      var n = state.searchResults[i]
      h.push('<div class="result' + (i === state.searchIndex ? ' active' : '') + '" data-id="' + esc(n.id) + '">' +
        '<span class="rid">' + esc(n.id) + '</span><span class="rtitle">' + esc(n.title || '') + '</span></div>')
    }
    box.innerHTML = h.join('')
    var rows = box.querySelectorAll('.result')
    for (var r = 0; r < rows.length; r++)
      rows[r].onclick = (function (id) { return function () { jumpTo(id); closeSearch() } })(rows[r].dataset.id)
  }

  // -------------------------------------------------------------- projects
  function openProjects() {
    state.projectsOpen = true
    state.projectsIndex = Math.max(0, state.projects.findIndex(function (p) { return p.jsonPath === state.rootJsonPath }))
    $('projectsWrap').classList.remove('hidden')
    renderProjects()
  }
  function closeProjects() { state.projectsOpen = false; $('projectsWrap').classList.add('hidden') }
  function projectMove(d) {
    if (!state.projects.length) return
    state.projectsIndex = (state.projectsIndex + d + state.projects.length) % state.projects.length
    renderProjects()
  }
  function acceptProject() {
    var p = state.projects[state.projectsIndex]
    closeProjects()
    if (p) loadProject(p)
  }
  function renderProjects() {
    var box = $('projectsList')
    var h = []
    for (var i = 0; i < state.projects.length; i++) {
      var p = state.projects[i]
      var sub = (p.nodes || 0) + ' nodes' + (p.repo ? ' · ' + p.repo : '')
      h.push('<div class="proj' + (i === state.projectsIndex ? ' active' : '') + '" data-i="' + i + '">' +
        '<div class="prow"><span class="pname">' + esc(p.name) + '</span>' +
        (p.jsonPath === state.rootJsonPath ? '<span class="pactive">active</span>' : '') + '</div>' +
        '<span class="pmeta">' + esc(sub) + '</span></div>')
    }
    box.innerHTML = h.join('')
    var rows = box.querySelectorAll('.proj')
    for (var r = 0; r < rows.length; r++)
      rows[r].onclick = (function (idx) { return function () { state.projectsIndex = idx; acceptProject() } })(Number(rows[r].dataset.i))
  }
  // route project-modal keys through the main handler
  document.addEventListener('keydown', function (ev) {
    if (!state.projectsOpen) return
    if (ev.key === 'ArrowDown') { projectMove(1); ev.preventDefault() }
    else if (ev.key === 'ArrowUp') { projectMove(-1); ev.preventDefault() }
    else if (ev.key === 'Enter') { acceptProject(); ev.preventDefault() }
    else if (ev.key === 'Escape') { closeProjects(); ev.preventDefault() }
  })

  // --------------------------------------------------------------- breadcrumb
  function renderBreadcrumb() {
    var bar = $('navBar')
    if (state.navStack.length === 0) { bar.classList.add('hidden'); bar.innerHTML = ''; return }
    var crumbs = state.navStack.map(function (s) { return s.title })
    crumbs.push(state.viewTitle || $('title').textContent)
    var h = []
    for (var i = 0; i < crumbs.length; i++) {
      var current = i === crumbs.length - 1
      h.push('<span class="crumb' + (current ? ' current' : '') + '" data-d="' + i + '">' + esc(crumbs[i]) + '</span>')
      if (!current) h.push('<span class="sep">\u203a</span>')
    }
    bar.innerHTML = h.join('')
    bar.classList.remove('hidden')
    var cs = bar.querySelectorAll('.crumb')
    for (var c = 0; c < cs.length; c++)
      cs[c].onclick = (function (d) { return function () { goToCrumb(d) } })(Number(cs[c].dataset.d))
  }

  // ------------------------------------------------------------------ theme
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t) }
  function toggleTheme() {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
    applyTheme(t)
    localStorage.setItem('flowview-theme', t)
  }

  // ---------------------------------------------------------------- export
  var FONT = 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace'

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }
  function exportColors() {
    return {
      bg: cssVar('--bg') || '#101428',
      fg: cssVar('--fg') || '#f2f4f8',
      muted: cssVar('--muted') || '#8b93a7',
      accent: cssVar('--accent') || '#1e90ff',
      urgent: cssVar('--urgent') || '#a55555',
      node: cssVar('--node') || '#171b34',
      border: cssVar('--border') || 'rgba(242,244,248,0.3)',
      table: cssVar('--table') || '#4ec9b0'
    }
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
  function diamondPath(ctx, x, y, w, h) {
    ctx.beginPath()
    ctx.moveTo(x + w / 2, y + 4)
    ctx.lineTo(x + w - 4, y + h / 2)
    ctx.lineTo(x + w / 2, y + h - 4)
    ctx.lineTo(x + 4, y + h / 2)
    ctx.closePath()
  }
  function ellipsize(ctx, text, maxW) {
    text = String(text == null ? '' : text)
    if (ctx.measureText(text).width <= maxW) return text
    var lo = 0, hi = text.length
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2)
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1
    }
    return text.slice(0, lo) + '…'
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    var words = String(text || '').split(/\s+/)
    var lines = [], i = 0
    while (i < words.length && lines.length < maxLines) {
      var line = words[i++]
      while (i < words.length) {
        var t = line + ' ' + words[i]
        if (ctx.measureText(t).width > maxW) break
        line = t; i++
      }
      if (lines.length === maxLines - 1 && i < words.length) {
        line = ellipsize(ctx, line + ' ' + words.slice(i).join(' '), maxW)
        i = words.length
      }
      lines.push(line)
    }
    return lines.length ? lines : ['']
  }
  function ringFor(level, C) {
    if (level === 'selected') return { color: C.accent, width: 3, alpha: 1 }
    if (level === 'successor') return { color: C.accent, width: 2.4, alpha: 1 }
    if (level === 'downstream') return { color: C.accent, width: 2.2, alpha: 0.85 }
    if (level === 'ancestor') return { color: C.accent, width: 2, alpha: 0.55 }
    return { color: C.border, width: 1, alpha: 1 }
  }
  function typeAccent(n, C) {
    if (n.type === 'external') return C.muted
    if (n.type === 'table') return C.table
    return C.fg
  }
  function drawBadgeEx(ctx, label, rightX, midY, C) {
    ctx.save()
    ctx.font = 'bold 7px ' + FONT
    var w = ctx.measureText(label).width + 6
    roundRectPath(ctx, rightX - w, midY - 6, w, 12, 3)
    ctx.globalAlpha *= 0.22; ctx.fillStyle = C.table; ctx.fill()
    ctx.globalAlpha /= 0.22
    ctx.fillStyle = C.table; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, rightX - w / 2, midY + 0.5)
    ctx.restore()
    return w
  }

  function drawEdgeEx(ctx, e, C) {
    var s = effRect(e.from), t = effRect(e.to)
    if (!s || !t) return
    var geom = FM.edgeGeometry(s, t, e.back === true)
    var lvl = edgeLevel(e)
    var alpha = lvl === 'dim' ? 0.12 : 1
    var color = (lvl === 'hot' || lvl === 'up') ? C.accent : C.fg
    var width = lvl === 'hot' ? 3 : (lvl === 'up' ? 1.8 : 1.4)
    var strength = lvl === 'up' ? 0.55 : (lvl === 'hot' ? 1 : 0.32)
    ctx.save()
    ctx.globalAlpha = alpha * strength
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(geom.x1, geom.y1)
    ctx.bezierCurveTo(geom.c1x, geom.c1y, geom.c2x, geom.c2y, geom.x2, geom.y2)
    ctx.stroke()
    var ar = FM.arrow(geom, 11)
    ctx.beginPath(); ctx.moveTo(ar.tipX, ar.tipY); ctx.lineTo(ar.leftX, ar.leftY)
    ctx.lineTo(ar.rightX, ar.rightY); ctx.closePath()
    ctx.fillStyle = color; ctx.fill()
    ctx.restore()

    var txt = (e.label && e.label.length) ? e.label : (e.when ? 'when ' + e.when : '')
    if (!txt || lvl === 'dim') return
    var mx = (geom.c1x + geom.c2x) / 2, my = (geom.c1y + geom.c2y) / 2
    ctx.save()
    ctx.font = '9px ' + FONT
    var w = ctx.measureText(txt).width
    ctx.globalAlpha = 0.92; ctx.fillStyle = C.bg
    roundRectPath(ctx, mx - w / 2 - 4, my - 7, w + 8, 14, 4); ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = (lvl === 'hot' || lvl === 'up') ? C.accent : C.muted
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(txt, mx, my)
    ctx.restore()
  }

  function drawNodeEx(ctx, n, C) {
    var r = effRect(n.id)
    if (!r) return
    var level = nodeLevel(n.id)
    var dim = state.selectedId && level === 'normal'
    ctx.save()
    ctx.globalAlpha = dim ? 0.22 : 1
    if (n.type === 'table') drawTableEx(ctx, n, r, level, C)
    else if (n.type === 'decision') drawDecisionEx(ctx, n, r, level, C)
    else drawCardEx(ctx, n, r, level, C)
    ctx.restore()
  }

  function drawCardEx(ctx, n, r, level, C) {
    var terminal = isTerminal(n)
    var ring = ringFor(level, C)
    ctx.save()
    ctx.globalAlpha *= ring.alpha
    roundRectPath(ctx, r.x, r.y, r.w, r.h, terminal ? r.h / 2 : 12)
    ctx.fillStyle = C.node; ctx.fill()
    ctx.strokeStyle = ring.color; ctx.lineWidth = ring.width; ctx.stroke()
    ctx.restore()

    if (!terminal) {
      ctx.save()
      ctx.fillStyle = typeAccent(n, C)
      roundRectPath(ctx, r.x + 7, r.y + 11, 4, r.h - 22, 2); ctx.fill()
      ctx.restore()
    }

    var left = r.x + (terminal ? 20 : 16), right = r.x + r.w - (terminal ? 20 : 16)
    var maxW = right - left, cx = r.x + r.w / 2
    var bottom = r.y + r.h - 9

    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillStyle = C.fg; ctx.font = 'bold 13px ' + FONT
    var lines = wrapLines(ctx, n.title || n.id, maxW, terminal ? 1 : 2)
    var ty = r.y + 9
    for (var i = 0; i < lines.length; i++) { ctx.fillText(lines[i], cx, ty); ty += 15 }
    ctx.fillStyle = C.muted; ctx.font = '9px ' + FONT
    ctx.fillText(ellipsize(ctx, n.id, maxW), cx, ty + 1)

    var sub = hasSubflow(n)
    if (sub) {
      var sh = 15, sy = bottom - sh
      ctx.save(); ctx.globalAlpha *= 0.2; ctx.fillStyle = C.accent
      roundRectPath(ctx, left, sy, maxW, sh, 4); ctx.fill(); ctx.restore()
      ctx.fillStyle = C.accent; ctx.font = '8px ' + FONT
      ctx.textBaseline = 'middle'
      ctx.fillText('\u21b3 open subflow · ' + (n.subflowNodes || 0), cx, sy + sh / 2)
    }
    var meta = metaText(n)
    if (meta) {
      var mb = sub ? bottom - 15 - 3 : bottom
      ctx.fillStyle = C.muted; ctx.font = '9px ' + FONT
      ctx.textBaseline = 'bottom'
      ctx.fillText(ellipsize(ctx, meta, maxW), cx, mb)
    }
  }

  function drawDecisionEx(ctx, n, r, level, C) {
    var ring = ringFor(level, C)
    ctx.save()
    ctx.globalAlpha *= ring.alpha
    diamondPath(ctx, r.x, r.y, r.w, r.h)
    ctx.fillStyle = C.node; ctx.fill()
    ctx.strokeStyle = ring.color; ctx.lineWidth = ring.width; ctx.stroke()
    ctx.restore()

    var maxW = r.w - 68, cx = r.x + r.w / 2
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillStyle = C.fg; ctx.font = 'bold 12px ' + FONT
    var lines = wrapLines(ctx, n.title || n.id, maxW, 2)
    var total = lines.length * 14 + 12
    var ty = r.y + r.h / 2 - total / 2
    for (var i = 0; i < lines.length; i++) { ctx.fillText(lines[i], cx, ty); ty += 14 }
    ctx.fillStyle = C.muted; ctx.font = '9px ' + FONT
    ctx.fillText(ellipsize(ctx, n.id, maxW), cx, ty + 1)
  }

  function drawTableEx(ctx, n, r, level, C) {
    var ring = ringFor(level, C)
    ctx.save()
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 12)
    ctx.save(); ctx.clip()
    ctx.fillStyle = C.node; ctx.fill()
    ctx.save(); ctx.globalAlpha *= 0.18; ctx.fillStyle = C.table
    ctx.fillRect(r.x, r.y, r.w, 24)
    ctx.restore()
    ctx.fillStyle = C.table
    ctx.fillRect(r.x, r.y + 23, r.w, 1)
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    ctx.fillStyle = C.fg; ctx.font = 'bold 11px ' + FONT
    ctx.fillText(ellipsize(ctx, n.title || n.id, r.w - 70), r.x + 8, r.y + 12)
    if (n.schema) {
      ctx.fillStyle = C.muted; ctx.font = '9px ' + FONT; ctx.textAlign = 'right'
      ctx.fillText(n.schema, r.x + r.w - 8, r.y + 12)
    }
    var cols = FM.displayColumns(n.columns, 5)
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i]
      var mid = r.y + 24 + i * 18 + 9
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillStyle = C.fg; ctx.font = '10px ' + FONT
      ctx.fillText(ellipsize(ctx, c.name, r.w * 0.5 - 12), r.x + 8, mid)
      var rx = r.x + r.w - 8
      if (c.type) {
        ctx.textAlign = 'right'; ctx.fillStyle = C.muted; ctx.font = '9px ' + FONT
        ctx.fillText(c.type, rx, mid)
        rx -= ctx.measureText(c.type).width + 6
      }
      if (c.fk) rx -= drawBadgeEx(ctx, 'FK', rx, mid, C) + 4
      if (c.pk) rx -= drawBadgeEx(ctx, 'PK', rx, mid, C) + 4
    }
    var total = n.columns ? n.columns.length : 0
    if (total > cols.length) {
      var hid = total - cols.length
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = C.muted; ctx.font = '8px ' + FONT
      ctx.fillText('+' + hid + ' more column' + (hid === 1 ? '' : 's') + ' (see details)',
        r.x + r.w / 2, r.y + 24 + cols.length * 18 + 8)
    }
    ctx.restore()
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 12)
    ctx.strokeStyle = ring.color; ctx.lineWidth = ring.width; ctx.globalAlpha *= ring.alpha; ctx.stroke()
    ctx.restore()
  }

  function exportPng() {
    var g = state.graph
    if (!g || !g.nodes.length) return
    var C = exportColors()
    var b = effBounds()
    var pad = 70, headerH = 54
    var worldW = b.width + pad * 2
    var worldH = b.height + pad * 2 + headerH
    var scale = Math.max(1, Math.min(2, 12000 / Math.max(worldW, worldH)))
    var canvas = document.createElement('canvas')
    canvas.width = Math.round(worldW * scale)
    canvas.height = Math.round(worldH * scale)
    var ctx = canvas.getContext('2d')
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.save(); ctx.scale(scale, scale)

    var title = state.viewTitle || $('title').textContent
    ctx.fillStyle = C.accent; ctx.font = 'bold 18px ' + FONT
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText('\u22b3', pad, 30)
    ctx.fillStyle = C.fg
    ctx.fillText(title, pad + 26, 31)
    ctx.fillStyle = C.muted; ctx.font = '11px ' + FONT
    ctx.fillText(g.nodes.length + ' nodes · ' + g.edges.length + ' edges', pad + 26, 48)

    ctx.translate(pad - b.minX, pad + headerH - b.minY)
    for (var i = 0; i < g.edges.length; i++) drawEdgeEx(ctx, g.edges[i], C)
    for (var j = 0; j < g.nodes.length; j++) drawNodeEx(ctx, g.nodes[j], C)
    ctx.restore()

    var q = new URLSearchParams(location.search)
    if (q.get('preview') === '1') {
      document.body.innerHTML = ''
      document.body.style.background = C.bg
      canvas.style.maxWidth = '100%'
      canvas.style.height = 'auto'
      document.body.appendChild(canvas)
      return
    }
    var slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'flow'
    canvas.toBlob(function (blob) {
      if (!blob) return
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = slug + '.png'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(function () { URL.revokeObjectURL(a.href) }, 2000)
    }, 'image/png')
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
