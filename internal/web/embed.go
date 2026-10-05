// Package web holds the embedded single-page frontend.
package web

import "embed"

// FS is the embedded web assets served at the site root.
//
//go:embed index.html app.js model.js style.css
var FS embed.FS
