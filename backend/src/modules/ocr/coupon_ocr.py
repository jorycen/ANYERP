import argparse
import json
import os
import sys

from paddleocr import PaddleOCR

from coupon_parser import parse_coupon_code


def extract_texts(result) -> list[str]:
    texts = []
    for page in result or []:
        for line in page or []:
            if len(line) >= 2 and isinstance(line[1], (list, tuple)) and line[1]:
                texts.append(str(line[1][0]))
    return texts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--scene", default="")
    args = parser.parse_args()

    if not os.path.exists(args.image):
        raise FileNotFoundError(args.image)

    ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    result = ocr.ocr(args.image, cls=True)
    texts = extract_texts(result)
    parsed = parse_coupon_code(texts)

    print(json.dumps({
        "scene": args.scene,
        "couponCode": parsed["couponCode"],
        "candidates": parsed["candidates"],
        "rawText": parsed["rawText"],
        "texts": texts,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({
            "error": str(error)
        }, ensure_ascii=False), file=sys.stderr)
        raise
