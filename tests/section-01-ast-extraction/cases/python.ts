export const PY_COMPLEX_CODE = `
from abc import ABC, abstractmethod
from typing import Optional, List

class AbstractRepository(ABC):
    @abstractmethod
    def find_by_id(self, item_id: str) -> Optional[dict]:
        pass

class SqlRepository(AbstractRepository):
    """Concrete SQL repository with typed methods."""

    def __init__(self, dsn: str, max_conns: int = 5):
        self.dsn = dsn
        self._max_conns = max_conns

    def find_by_id(self, item_id: str) -> Optional[dict]:
        return {"id": item_id}

    async def batch_insert(self, items: List[dict]) -> int:
        return len(items)

def create_repo(dsn: str) -> SqlRepository:
    return SqlRepository(dsn)
`;
