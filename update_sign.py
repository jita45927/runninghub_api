"""更新清单的 Ed25519 签名与验签。

用途：
- 发布端：用本地私钥给 build/latest.json 签名，生成 signature 字段；
- 客户端：用内置公钥验签，确认版本、安装包地址、SHA256、大小没有被篡改。

私钥默认保存在项目 .private/update_signing_key.pem，已加入 .gitignore。
可通过环境变量 RH_UPDATE_KEY 指定私钥路径，RH_UPDATE_KEY_PASS 指定私钥密码。
"""
import argparse
import base64
import json
import os
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_KEY_PATH = os.path.join(ROOT, ".private", "update_signing_key.pem")
KEY_ENV = "RH_UPDATE_KEY"
KEY_PASS_ENV = "RH_UPDATE_KEY_PASS"

# 由 `python update_sign.py --generate` 生成后粘贴到这里；只包含公钥，可以公开。
PUBLIC_KEY_B64 = "g7v2KfkoP5WbGHwINYEyHvXYPc0m0ZnH3TzNval5zN0="


def default_key_path():
    return os.environ.get(KEY_ENV) or DEFAULT_KEY_PATH


def canonical_bytes(manifest):
    """去掉 signature 后按固定规则序列化，签发端与验签端必须完全一致。"""
    if not isinstance(manifest, dict):
        raise ValueError("更新清单必须是 JSON 对象")
    payload = {k: v for k, v in manifest.items() if k != "signature"}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def public_key_b64():
    return PUBLIC_KEY_B64


def load_private_key(path=None):
    path = path or default_key_path()
    password = os.environ.get(KEY_PASS_ENV) or None
    with open(path, "rb") as f:
        data = f.read()
    key = serialization.load_pem_private_key(data, password=password.encode("utf-8") if password else None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("私钥不是 Ed25519 格式")
    return key


def _load_public_key():
    if not PUBLIC_KEY_B64:
        raise ValueError("客户端尚未配置更新清单公钥")
    try:
        raw = base64.b64decode(PUBLIC_KEY_B64.encode("ascii"), validate=True)
    except Exception as e:
        raise ValueError("更新清单公钥格式无效") from e
    if len(raw) != 32:
        raise ValueError("更新清单公钥长度无效")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_manifest(manifest):
    signature = manifest.get("signature") if isinstance(manifest, dict) else None
    if not isinstance(signature, str) or not signature.strip():
        raise ValueError("更新清单缺少签名")
    try:
        raw = base64.b64decode(signature.encode("ascii"), validate=True)
    except Exception as e:
        raise ValueError("更新清单签名格式无效") from e
    if len(raw) != 64:
        raise ValueError("更新清单签名长度无效")
    try:
        _load_public_key().verify(raw, canonical_bytes(manifest))
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("更新清单签名校验失败") from e
    return True


def sign_manifest(manifest, key_path=None):
    if not isinstance(manifest, dict):
        raise ValueError("更新清单必须是 JSON 对象")
    key = load_private_key(key_path)
    signature = key.sign(canonical_bytes(manifest))
    signed = dict(manifest)
    signed["signature"] = base64.b64encode(signature).decode("ascii")
    return signed


def generate_key(path=None, force=False):
    path = path or default_key_path()
    if os.path.exists(path) and not force:
        raise SystemExit("私钥已存在：%s（如需覆盖请加 --force）" % path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    key = Ed25519PrivateKey.generate()
    password = os.environ.get(KEY_PASS_ENV) or None
    encryption = (serialization.BestAvailableEncryption(password.encode("utf-8"))
                  if password else serialization.NoEncryption())
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=encryption,
    )
    with open(path, "wb") as f:
        f.write(pem)
    raw_pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return os.path.abspath(path), base64.b64encode(raw_pub).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description="更新清单 Ed25519 签名工具")
    parser.add_argument("--generate", action="store_true", help="生成新的密钥对")
    parser.add_argument("--force", action="store_true", help="允许覆盖已有私钥")
    parser.add_argument("--sign", metavar="MANIFEST", help="给清单文件签名（原地写回）")
    parser.add_argument("--verify", metavar="MANIFEST", help="校验清单签名")
    args = parser.parse_args()

    if args.generate:
        path, pub = generate_key(force=args.force)
        print("已生成私钥：" + path)
        print("公钥（粘贴到 update_sign.py 的 PUBLIC_KEY_B64）：")
        print(pub)
        print("请立即离线备份私钥；丢失后老客户端将无法验证新版本。")
        return

    if args.sign:
        with open(args.sign, encoding="utf-8") as f:
            manifest = json.load(f)
        signed = sign_manifest(manifest)
        with open(args.sign, "w", encoding="utf-8") as f:
            json.dump(signed, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("已签名：" + args.sign)
        return

    if args.verify:
        with open(args.verify, encoding="utf-8") as f:
            manifest = json.load(f)
        verify_manifest(manifest)
        print("签名有效：" + args.verify)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
