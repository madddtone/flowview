// Command flowview is a self-contained local web server for viewing compiled
// Flow Tracker graphs (flow.json). It serves a directory of flow JSON plus an
// embedded single-page viewer; no repo, no flowc, no build step.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madddtone/flowview/internal/server"
)

const version = "0.2.0"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		cmdServe(nil)
		return
	}
	switch args[0] {
	case "serve":
		cmdServe(args[1:])
	case "pack":
		cmdPack(args[1:])
	case "list", "ls":
		cmdList(args[1:])
	case "version", "--version", "-v":
		fmt.Println("flowview " + version)
	case "help", "--help", "-h":
		usage()
	default:
		// `flowview <dir>` is shorthand for serve.
		if strings.HasPrefix(args[0], "-") {
			cmdServe(args)
		} else {
			cmdServe(args)
		}
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `flowview `+version+` - local web viewer for Flow Tracker graphs

Usage:
  flowview [dir] [--port 8787] [--host 127.0.0.1] [--open=false]
  flowview serve [dir] [flags]      same as above
  flowview list [dir]               list the flows found in dir
  flowview pack <project> -o <dir>  copy a flowc project into a portable folder
  flowview version

dir defaults to the flowc store (~/.local/share/flow-tracker) when present,
otherwise the current directory. It may be the store or any folder of flows.
`)
}

// ------------------------------------------------------------------- serve

func cmdServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", 8787, "port to listen on")
	host := fs.String("host", "127.0.0.1", "host/interface to bind")
	open := fs.Bool("open", true, "open the browser")
	parseInterspersed(fs, args)

	dir := defaultDir()
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}
	srv, err := server.New(dir)
	if err != nil {
		fatal(err)
	}

	addr := net.JoinHostPort(*host, fmt.Sprint(*port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal(fmt.Errorf("cannot listen on %s: %w", addr, err))
	}
	url := "http://" + displayHost(*host) + ":" + fmt.Sprint(*port) + "/"

	fmt.Printf("flowview serving %s\n", srv.Root())
	fmt.Printf("  %d flow(s) found\n", len(srv.Projects()))
	for _, p := range srv.Projects() {
		fmt.Printf("    - %s (%d nodes)\n", p.Name, p.Nodes)
	}
	fmt.Printf("open: %s\n", url)
	if *open {
		go openBrowser(url)
	}
	if err := http.Serve(ln, srv.Handler()); err != nil {
		fatal(err)
	}
}

func displayHost(h string) string {
	if h == "0.0.0.0" || h == "::" || h == "" {
		return "localhost"
	}
	return h
}

// -------------------------------------------------------------------- pack

func cmdPack(args []string) {
	fs := flag.NewFlagSet("pack", flag.ExitOnError)
	out := fs.String("o", "", "output directory")
	store := fs.String("store", storeRoot(), "flowc store root")
	parseInterspersed(fs, args)
	if fs.NArg() == 0 {
		fatal(fmt.Errorf("usage: flowview pack <project> -o <dir>"))
	}
	ref := fs.Arg(0)
	if *out == "" {
		fatal(fmt.Errorf("-o <dir> is required"))
	}

	projects, err := server.Discover(*store)
	if err != nil {
		fatal(err)
	}
	var match *server.Project
	for i := range projects {
		if projects[i].ID == ref || strings.EqualFold(projects[i].Name, ref) {
			match = &projects[i]
			break
		}
	}
	if match == nil {
		fatal(fmt.Errorf("no project %q in %s (try `flowview list`)", ref, *store))
	}

	srcDir := filepath.Join(*store, filepath.FromSlash(filepath.Dir(match.JSONPath)))
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fatal(err)
	}
	// Copy every .json and .md in the project directory (flow + subflows).
	copied := 0
	entries, _ := os.ReadDir(srcDir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext != ".json" && ext != ".md" {
			continue
		}
		if err := copyFile(filepath.Join(srcDir, e.Name()), filepath.Join(*out, e.Name())); err != nil {
			fatal(err)
		}
		copied++
	}
	if copied == 0 {
		fatal(fmt.Errorf("nothing to copy from %s", srcDir))
	}

	index := map[string]any{
		"version": 1,
		"projects": []map[string]any{{
			"id": match.ID, "name": match.Name, "description": match.Description,
			"repo": match.Repo, "nodes": match.Nodes, "edges": match.Edges,
			"jsonPath": "flow.json",
		}},
	}
	data, _ := json.MarshalIndent(index, "", "  ")
	if err := os.WriteFile(filepath.Join(*out, "index.json"), append(data, '\n'), 0o644); err != nil {
		fatal(err)
	}

	fmt.Printf("packed %q -> %s (%d files)\n\nsend that folder to your friend, then:\n  flowview %s\n", match.Name, *out, copied, *out)
}

// -------------------------------------------------------------------- list

func cmdList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	parseInterspersed(fs, args)
	dir := defaultDir()
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}
	projects, err := server.Discover(dir)
	if err != nil {
		fatal(err)
	}
	if len(projects) == 0 {
		fmt.Printf("no flows found in %s\n", dir)
		return
	}
	fmt.Printf("flows in %s:\n", dir)
	for _, p := range projects {
		fmt.Printf("  %-28s %-9s %s\n", p.ID, fmt.Sprintf("%d/%d", p.Nodes, p.Edges), p.Name)
	}
}

// ------------------------------------------------------------------- utils

func defaultDir() string {
	if dirExists(storeRoot()) {
		return storeRoot()
	}
	return "."
}

func storeRoot() string {
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "flow-tracker")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".local", "share", "flow-tracker")
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// parseInterspersed parses flags even after positional arguments.
func parseInterspersed(fs *flag.FlagSet, args []string) {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") && a != "-" && a != "--" {
			flags = append(flags, a)
			if !strings.Contains(a, "=") && flagTakesValue(fs, a) && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		pos = append(pos, a)
	}
	_ = fs.Parse(append(flags, pos...))
}

func flagTakesValue(fs *flag.FlagSet, name string) bool {
	f := fs.Lookup(strings.TrimLeft(name, "-"))
	if f == nil {
		return false
	}
	if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
		return false
	}
	return true
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "flowview: "+err.Error())
	os.Exit(1)
}
