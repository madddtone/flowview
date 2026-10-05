// Package server hosts the Flow Tracker web viewer over HTTP.
//
// It serves a directory of compiled flow JSON — either an Omarchy flowc
// central store (index.json + projects/<id>/flow.json) or any folder that
// contains flow JSON files — plus the embedded single-page frontend.
package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madddtone/flowview/internal/web"
)

// Project is one viewable flow, with paths relative to the served root.
type Project struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Nodes       int    `json:"nodes"`
	Edges       int    `json:"edges"`
	JSONPath    string `json:"jsonPath"` // forward-slashed, relative to root
	MD          string `json:"md,omitempty"`
}

// Index is the project list returned by /api/index.
type Index struct {
	Version  int       `json:"version"`
	Root     string    `json:"root"`
	Projects []Project `json:"projects"`
}

// Server serves the viewer and the flow data under root.
type Server struct {
	root     string
	projects []Project
	mux      *http.ServeMux
}

// New discovers the flows under root and returns a ready server.
func New(root string) (*Server, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", abs)
	}
	projects, err := Discover(abs)
	if err != nil {
		return nil, err
	}
	s := &Server{root: abs, projects: projects, mux: http.NewServeMux()}

	s.mux.HandleFunc("/api/index", s.handleIndex)
	s.mux.HandleFunc("/api/flow", s.handleFlow)
	s.mux.Handle("/", http.FileServer(http.FS(web.FS)))
	return s, nil
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler { return s.mux }

// Root returns the absolute served directory.
func (s *Server) Root() string { return s.root }

// Projects returns the discovered projects.
func (s *Server) Projects() []Project { return s.projects }

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, Index{Version: 1, Root: s.root, Projects: s.projects})
}

func (s *Server) handleFlow(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	full, err := s.resolve(rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

// resolve maps a client-supplied relative path to a real file inside root,
// rejecting traversal and non-JSON targets.
func (s *Server) resolve(rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("missing path")
	}
	clean := filepath.Clean("/" + filepath.ToSlash(rel))
	if strings.Contains(clean, "..") {
		return "", fmt.Errorf("invalid path")
	}
	full := filepath.Join(s.root, filepath.FromSlash(clean))
	relCheck, err := filepath.Rel(s.root, full)
	if err != nil || strings.HasPrefix(relCheck, "..") {
		return "", fmt.Errorf("path escapes root")
	}
	if !strings.EqualFold(filepath.Ext(full), ".json") {
		return "", fmt.Errorf("only .json is served")
	}
	return full, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// ---------------------------------------------------------------- discovery

// Discover returns the flows under root, auto-detecting the store shape.
func Discover(root string) ([]Project, error) {
	if p, ok := fromIndex(root); ok {
		return p, nil
	}
	if dirExists(filepath.Join(root, "projects")) {
		return fromStore(root)
	}
	return fromFolder(root)
}

type indexFile struct {
	Projects []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Repo        string `json:"repo"`
		Nodes       int    `json:"nodes"`
		Edges       int    `json:"edges"`
		JSONFile    string `json:"jsonFile"`
		JSONPath    string `json:"jsonPath"`
	} `json:"projects"`
}

// fromIndex uses an index.json (flowc store or a flowview pack bundle),
// remapping host-absolute paths to paths relative to root.
func fromIndex(root string) ([]Project, bool) {
	data, err := os.ReadFile(filepath.Join(root, "index.json"))
	if err != nil {
		return nil, false
	}
	var idx indexFile
	if err := json.Unmarshal(data, &idx); err != nil || len(idx.Projects) == 0 {
		return nil, false
	}
	var out []Project
	for _, p := range idx.Projects {
		full := ""
		switch {
		case p.JSONPath != "":
			cand := filepath.Join(root, filepath.FromSlash(p.JSONPath))
			if fileExists(cand) {
				full = cand
			}
		case p.JSONFile != "" && fileExists(p.JSONFile):
			full = p.JSONFile
		}
		if full == "" {
			cand := filepath.Join(root, "projects", p.ID, "flow.json")
			if fileExists(cand) {
				full = cand
			}
		}
		if full == "" {
			continue
		}
		rel, err := filepath.Rel(root, full)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		name, nodes, edges := p.Name, p.Nodes, p.Edges
		if name == "" || nodes == 0 {
			if n, ne, ee, ok := flowStats(full); ok {
				name = coalesce(name, n)
				nodes, edges = ne, ee
			}
		}
		if name == "" {
			name = p.ID
		}
		out = append(out, Project{
			ID: p.ID, Name: name, Description: p.Description, Repo: p.Repo,
			Nodes: nodes, Edges: edges, JSONPath: filepath.ToSlash(rel),
			MD: siblingMD(full),
		})
	}
	if len(out) == 0 {
		return nil, false
	}
	sortProjects(out)
	return out, true
}

func fromStore(root string) ([]Project, error) {
	dir := filepath.Join(root, "projects")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []Project
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		flowJSON := filepath.Join(dir, id, "flow.json")
		if !fileExists(flowJSON) {
			continue
		}
		p := Project{ID: id, Name: id, JSONPath: filepath.ToSlash(filepath.Join("projects", id, "flow.json")), MD: siblingMD(flowJSON)}
		if meta := readMeta(filepath.Join(dir, id, "meta.json")); meta != nil {
			p.Name = coalesce(meta.Name, id)
			p.Description = meta.Description
			p.Repo = meta.Repo
			p.Nodes = meta.Nodes
			p.Edges = meta.Edges
		}
		if n, ne, ee, ok := flowStats(flowJSON); ok {
			p.Name = coalesce(p.Name, n)
			if p.Nodes == 0 {
				p.Nodes, p.Edges = ne, ee
			}
		}
		out = append(out, p)
	}
	sortProjects(out)
	return out, nil
}

func fromFolder(root string) ([]Project, error) {
	var out []Project
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(path), ".json") || d.Name() == "index.json" {
			return nil
		}
		name, nodes, edges, ok := flowStats(path)
		if !ok {
			return nil // not a flow document
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		out = append(out, Project{
			ID:       strings.TrimSuffix(filepath.ToSlash(rel), ".json"),
			Name:     name,
			Nodes:    nodes,
			Edges:    edges,
			JSONPath: filepath.ToSlash(rel),
			MD:       siblingMD(path),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortProjects(out)
	return out, nil
}

type metaDoc struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Repo        string `json:"repo"`
	Nodes       int    `json:"nodes"`
	Edges       int    `json:"edges"`
}

func readMeta(path string) *metaDoc {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m metaDoc
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	return &m
}

// flowStats reads the flow name and node/edge counts. ok is false when the
// file is not a flow document (no nodes/edges arrays).
func flowStats(path string) (name string, nodes, edges int, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, 0, false
	}
	var doc struct {
		Flow  string            `json:"flow"`
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", 0, 0, false
	}
	if doc.Nodes == nil || doc.Edges == nil {
		return "", 0, 0, false
	}
	return doc.Flow, len(doc.Nodes), len(doc.Edges), true
}

func siblingMD(jsonPath string) string {
	md := strings.TrimSuffix(jsonPath, filepath.Ext(jsonPath)) + ".md"
	if fileExists(md) {
		return filepath.Base(md)
	}
	return ""
}

func sortProjects(p []Project) {
	sort.Slice(p, func(i, j int) bool {
		return strings.ToLower(p[i].Name) < strings.ToLower(p[j].Name)
	})
}

func coalesce(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
