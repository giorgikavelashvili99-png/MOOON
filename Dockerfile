FROM python:3.11-slim

# ffmpeg gives us ffprobe, which bot.py shells out to for video quality analysis.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Only bot2 needs this -- it runs a small internal web server for the
# /send-analytics endpoint (bot.py/bot #1 has no network-facing port at
# all). Most platforms (Railway/Render) auto-detect and map PORT for you;
# this EXPOSE is just documentation/for manual `docker run -p`.
EXPOSE 8080

CMD ["python", "bot.py"]
