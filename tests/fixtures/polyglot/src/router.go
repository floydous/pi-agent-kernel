package router

type ServiceHandler interface {
    ServeRequest(path string) bool
}

func InitRouter(name string) ServiceHandler {
    return nil
}
