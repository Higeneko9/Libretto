"""Japanese display names for the tags that ship with the sample library (keyed by lower-case English name)."""

JA_JP = {
    "angry": "怒り",
    "animal": "動物",
    "anime": "アニメ",
    "arm pose": "腕のポーズ",
    "boy": "男の子",
    "casual": "カジュアル",
    "cat": "猫",
    "chara": "キャラクター",
    "dress": "ドレス",
    "fantasy": "ファンタジー",
    "food": "食べ物",
    "formal": "フォーマル",
    "girl": "女の子",
    "hand pose": "手のポーズ",
    "hand sign": "ハンドサイン",
    "happy": "嬉しい",
    "house": "家",
    "locomotion": "移動",
    "long": "ロング",
    "lying": "横たわる",
    "neko": "ネコ",
    "outdoor": "屋外",
    "outfit": "服装",
    "park": "公園",
    "person": "人物",
    "portrait": "ポートレート",
    "sad": "悲しい",
    "sample": "サンプル",
    "scare": "恐怖",
    "school": "学校",
    "short": "ショート",
    "sitting": "座る",
    "standing": "立つ",
    "stuffed animal": "ぬいぐるみ",
    "summer": "夏",
    "surprise": "驚き",
    "swimsuit": "水着",
    "tied": "結んだ髪",
    "traditional": "和風",
    "umbrella": "傘",
    "uniform": "制服",
    "urban": "都会",
    "weapon": "武器",
    "woman": "女性",
}

BUNDLED = {"ja-JP": JA_JP}


def bundled_names(names: dict[str, str]) -> dict[str, str]:
    """Bundled translations for a tag, judged by any of its existing names (languages it already has are skipped)."""
    result = {}
    for locale, table in BUNDLED.items():
        if locale in names:
            continue
        for text in names.values():
            if text.strip().casefold() in table:
                result[locale] = table[text.strip().casefold()]
                break
    return result
