import os
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request
from paddleocr import PaddleOCR

from coupon_parser import parse_coupon_code


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("OCR_MAX_IMAGE_SIZE_MB", "8")) * 1024 * 1024

_ocr = None


def get_ocr():
    global _ocr
    if _ocr is None:
        _ocr = PaddleOCR(
            use_angle_cls=True,
            lang=os.getenv("OCR_LANG", "ch"),
            show_log=os.getenv("OCR_SHOW_LOG", "false").lower() == "true",
        )
    return _ocr


def extract_texts(result):
    texts = []
    for page in result or []:
        for line in page or []:
            if len(line) >= 2 and isinstance(line[1], (list, tuple)) and line[1]:
                texts.append(str(line[1][0]))
    return texts


def file_suffix(filename):
    suffix = Path(filename or "").suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".bmp", ".webp"} else ".jpg"


def validate_token():
    expected = os.getenv("OCR_SERVICE_TOKEN", "")
    if not expected:
        return True

    auth = request.headers.get("Authorization", "")
    token = request.headers.get("X-OCR-Token", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
    return token == expected


@app.get("/health")
def health():
    return jsonify({"code": 0, "message": "ok"})


@app.post("/ocr/coupon")
@app.post("/api/v1/ocr/coupon")
def recognize_coupon():
    if not validate_token():
        return jsonify({"code": 401, "message": "unauthorized"}), 401

    image = request.files.get("image")
    if image is None:
        return jsonify({"code": 400, "message": "image is required"}), 400

    scene = request.form.get("scene", "")
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_suffix(image.filename)) as temp_file:
            image.save(temp_file)
            temp_path = temp_file.name

        result = get_ocr().ocr(temp_path, cls=True)
        texts = extract_texts(result)
        parsed = parse_coupon_code(texts)
        return jsonify({
            "code": 0,
            "message": "ok",
            "data": {
                "scene": scene,
                "couponCode": parsed["couponCode"],
                "candidates": parsed["candidates"],
                "rawText": parsed["rawText"],
                "texts": texts,
            },
        })
    except Exception as error:
        return jsonify({"code": 500, "message": str(error)}), 500
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
