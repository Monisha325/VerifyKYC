FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# face_recognition declares a dependency on the package named "dlib" (no
# prebuilt wheels, would trigger a from-source build) rather than "dlib-bin"
# (which we just installed above, real wheels, same import name). --no-deps
# skips that check; its other actual dependencies are already satisfied by
# requirements.txt (face-recognition-models, click, numpy, pillow).
RUN pip install --no-cache-dir --no-deps face_recognition==1.3.0

COPY . .

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
