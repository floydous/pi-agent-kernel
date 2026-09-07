// Go fixture: interface with multiple implementations, error handling, and a complete server module.

package router

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type RouteHandler func(ctx context.Context, path string) (any, error)

type ServiceHandler interface {
	ServeRequest(ctx context.Context, path string) (any, error)
	Ping() error
	Shutdown() error
}

type FileStore struct {
	Path string
	mu   sync.Mutex
	open bool
}

func (f *FileStore) ServeRequest(ctx context.Context, path string) (any, error) {
	if !f.open {
		return nil, errors.New("file store is not open")
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return fmt.Sprintf("file://%s/%s", f.Path, path), nil
}

func (f *FileStore) Ping() error {
	if !f.open {
		return errors.New("file store is not open")
	}
	return nil
}

func (f *FileStore) Shutdown() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.open = false
	return nil
}

type Middleware func(ServiceHandler) ServiceHandler

type Router struct {
	root      ServiceHandler
	prefix    string
	mw        []Middleware
	timeoutMs int
}

func InitRouter(name string) ServiceHandler {
	return &FileStore{Path: name, open: true}
}

func NewRouter(root ServiceHandler, prefix string, timeoutMs int, mws ...Middleware) *Router {
	return &Router{root: root, prefix: prefix, mw: mws, timeoutMs: timeoutMs}
}

func (r *Router) ServeRequest(ctx context.Context, path string) (any, error) {
	h := r.root
	for i := len(r.mw) - 1; i >= 0; i-- {
		h = r.mw[i](h)
	}
	timedCtx, cancel := context.WithTimeout(ctx, time.Duration(r.timeoutMs)*time.Millisecond)
	defer cancel()
	return h.ServeRequest(timedCtx, fmt.Sprintf("%s%s", r.prefix, path))
}

func (r *Router) Ping() error {
	return r.root.Ping()
}

func (r *Router) Shutdown() error {
	return r.root.Shutdown()
}
