BIN := flowview
PREFIX ?= $(HOME)/.local

.PHONY: build test vet fmt install clean

build:
	go build -o bin/$(BIN) ./cmd/flowview

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

install: build
	install -Dm755 bin/$(BIN) $(PREFIX)/bin/$(BIN)

clean:
	rm -rf bin
