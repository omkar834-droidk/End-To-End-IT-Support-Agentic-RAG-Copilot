from pathlib import Path

from app.core.config import get_settings
from app.services.ingestion import load_file, chunk_documents
from app.rag.vectorstore import add_documents


settings = get_settings()

folder = Path(settings.sample_kb_dir)

files = [
    path
    for path in folder.iterdir()
    if path.is_file()
]

all_docs = []

for path in files:
    all_docs.extend(load_file(path))

chunks = chunk_documents(all_docs)

ids = add_documents(chunks)

print(
    f"Indexed {len(files)} files -> "
    f"{len(chunks)} chunks -> "
    f"{len(ids)} Pinecone vectors"
)