import json
import os
import sqlite3
from pathlib import Path


def pick_shared_row(rows):
    if not isinstance(rows, list) or not rows:
        return None
    for r in rows:
        if isinstance(r, dict) and r.get("父子关系") == "parent":
            return r
    return rows[0] if isinstance(rows[0], dict) else None


def print_detail_keys(label, data_obj):
    if not isinstance(data_obj, dict):
        print(label, "not an object")
        return
    rows = data_obj.get("rows")
    shared = pick_shared_row(rows)
    if not isinstance(shared, dict):
        print(label, "no shared row")
        return
    # 打印所有包含“详情”相关 key（用 unicode_escape，避免控制台编码导致显示为 ????）
    detail_keys = []
    for k in shared.keys():
        ks = str(k)
        if "详情" in ks and not ks.startswith("详情图") and not ks.endswith("_value_xpath"):
            detail_keys.append(k)

    def uesc(x: str) -> str:
        return x.encode("unicode_escape").decode("ascii")

    print(label, "shared detail keys =", [uesc(str(k)) for k in detail_keys])
    for k in detail_keys:
        v = shared.get(k)
        if isinstance(v, str):
            sample = v[:240].replace("\n", "\\n")
            print(f"  key={uesc(str(k))}: str len={len(v)} sample={uesc(sample)}")
        else:
            print(f"  key={uesc(str(k))}: type={type(v).__name__}")


def main():
    root = Path(r"e:\ai-web-scrapy（分支_V2.3）")
    db_path = Path(os.environ.get("DB_PATH") or (root / "server" / "data.db"))
    print("db_path =", db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    row = cur.execute(
        """
        SELECT id, user_id, platform, url, collected_at,
               ai_post_status, export_dest_platform_id, ai_prompt_platform_key,
               LENGTH(generic_data_json) AS gen_len,
               LENGTH(platform_data_json) AS plat_len
          FROM collections
         WHERE id=?
        """,
        (277,),
    ).fetchone()

    print("row exists =", bool(row))
    if not row:
        return
    for k in row.keys():
        print(k, "=", row[k])

    row2 = cur.execute(
        "SELECT generic_data_json, platform_data_json, data_json FROM collections WHERE id=?",
        (277,),
    ).fetchone()

    generic_json = (row2["generic_data_json"] or "").strip()
    platform_json = (row2["platform_data_json"] or "").strip()
    data_json = (row2["data_json"] or "").strip()

    def safe_load(s):
        try:
            return json.loads(s) if s else None
        except Exception as e:
            return {"__parse_error__": str(e), "__head__": s[:200]}

    generic_obj = safe_load(generic_json)
    platform_obj = safe_load(platform_json)
    data_obj = safe_load(data_json)

    print_detail_keys("generic_data_json", generic_obj)
    print_detail_keys("platform_data_json", platform_obj)
    print_detail_keys("data_json", data_obj)

    con.close()


if __name__ == "__main__":
    main()

