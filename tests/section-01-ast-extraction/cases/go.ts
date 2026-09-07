export const GO_COMPLEX_CODE = `
package storage

type Reader interface {
    ReadAt(p []byte, off int64) (n int, err error)
}

type FileStore struct {
    Path string
}

func (f *FileStore) ReadAt(p []byte, off int64) (int, error) {
    return len(p), nil
}

func OpenStore(path string) (*FileStore, error) {
    return &FileStore{Path: path}, nil
}
`;
