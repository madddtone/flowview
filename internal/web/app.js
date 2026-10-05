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
      loadProject(chosen || state.projects[0])
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
    loadFlow(p.jsonPath)
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
    div.className = 'node type-' + n.type + (isTerminal(n) ? ' terminal' : '') + (n.type === 'decision' ? ' decision' : '')
    div.dataset.id = n.id
    div.style.width = n.rect.w + 'px'
    div.style.height = n.rect.h + 'px'

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

  document.addEventListener('DOMContentLoaded', boot)
})()
