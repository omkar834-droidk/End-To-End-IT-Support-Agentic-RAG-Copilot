# from pathlib import Path

# from app.rag.vectorstore import add_documents
# from app.services.ingestion import load_file, chunk_documents


# path = Path("data/sample.kb/company_it_handbook.md")

# docs = load_file(path)

# chunks = chunk_documents(docs)

# add_documents(chunks)

# print(f"Documents loaded: {len(docs)}")
# print(f"Chunks created: {len(chunks)}")
# print("Documents added to Pinecone successfully!")



import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8080, reload=True)