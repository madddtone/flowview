package server

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const flowJSON = `{"version":1,"flow":"Demo","start":"a",
"nodes":[{"id":"a","type":"start","title":"A","rect":{"x":0,"y":0,"w":10,"h":10}}],
"edges":[]}`

func TestDiscoverFolder(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "flow.json"), flowJSON)
	writeFile(t, filepath.Join(dir, "sub", "child.json"), `{"version":1,"flow":"Child","nodes":[],"edges":[]}`)
	writeFile(t, filepath.Join(dir, "notes.txt"), "ignore me")

	projects, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected 2 projects, got %d: %+v", len(projects), projects)
	}
	if projects[0].JSONPath == "" {
		t.Fatalf("expected a jsonPath")
	}
}

func TestDiscoverStore(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "projects", "demo", "flow.json"), flowJSON)
	writeFile(t, filepath.Join(dir, "projects", "demo", "meta.json"),
		`{"id":"demo","name":"Demo Project","repo":"/repo","nodes":7,"edges":3}`)

	projects, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	p := projects[0]
	if p.Name != "Demo Project" || p.Repo != "/repo" || p.Nodes != 7 {
		t.Fatalf("bad meta merge: %+v", p)
	}
	if p.JSONPath != "projects/demo/flow.json" {
		t.Fatalf("expected relative jsonPath, got %q", p.JSONPath)
	}
}

func TestResolvePathSafety(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "flow.json"), flowJSON)
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.resolve("flow.json"); err != nil {
		t.Fatalf("valid path rejected: %v", err)
	}
	if _, err := s.resolve("../etc/passwd"); err == nil {
		t.Fatalf("traversal should be rejected")
	}
	if _, err := s.resolve("a/b/../../../etc/passwd"); err == nil {
		t.Fatalf("nested traversal should be rejected")
	}
	if _, err := s.resolve("flow.txt"); err == nil {
		t.Fatalf("non-json should be rejected")
	}
}

func TestIndexFromPackedBundle(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "flow.json"), flowJSON)
	writeFile(t, filepath.Join(dir, "index.json"),
		`{"version":1,"projects":[{"id":"x","name":"Packed","jsonPath":"flow.json","nodes":1,"edges":0}]}`)

	projects, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].Name != "Packed" || projects[0].JSONPath != "flow.json" {
		t.Fatalf("packed index not honored: %+v", projects)
	}
}
