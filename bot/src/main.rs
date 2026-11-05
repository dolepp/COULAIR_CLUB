//! Бот COULAIR CLUB.
//! Меню: Товары · Характеристики · Размерная сетка · Поддержка.
//! Товары, характеристики и размерную сетку берёт с сайта (coulair.ru: главная, js/main.js,
//! catalog/catalog.js), характеристики — ещё и из поста в канале (t.me/s/<канал>).
//! Поддержка — переход в аккаунт поддержки.
//!
//! Настройки (.env рядом с бинарём или переменные окружения):
//!   BOT_TOKEN         токен от @BotFather (обязательно)
//!   TG_API_BASE       https://api.telegram.org
//!   SITE_URL          https://coulair.ru
//!   SITE_RESOLVE      [2a12:5940:e50b::2]:443 — ходить на сайт по этому адресу (IPv4 до магазина закрыт)
//!   CHANNEL           coulairclub
//!   SUPPORT           coulair
//!   STATE_DIR         ./data — сюда сохраняется последний пост с характеристиками

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const CACHE_TTL: Duration = Duration::from_secs(600);

const BTN_PRODUCTS: &str = "Товары";
const BTN_SPECS: &str = "Характеристики";
const BTN_SIZES: &str = "Размерная сетка";
const BTN_SUPPORT: &str = "Поддержка";

/// Премиум-эмодзи (набор TgAndroidIcons — тот же, что в канале): (id, обычный эмодзи на замену)
type Em = (&'static str, &'static str);
mod em {
    use super::Em;
    pub const PRODUCTS: Em = ("5854776233950188167", "🏷");
    pub const SPECS: Em = ("5877597667231534929", "🗒");
    pub const SIZES: Em = ("5888642858533001671", "↔️");
    pub const SUPPORT: Em = ("5884510167986343350", "💬");
    pub const PRICE: Em = ("5811989245761426317", "💰");
    pub const STAR: Em = ("5874948844935974490", "⭐️");
    pub const SHIP: Em = ("5924720918826848520", "📦");
    pub const COND: Em = ("5931621672846103580", "💫");
    pub const PHOTO: Em = ("5846024087033353251", "📷");
    pub const BACK: Em = ("5877629862306385808", "◀️");
    pub const ORDER: Em = ("5967548335542767952", "💳");
    pub const YES: Em = ("5776375003280838798", "✅");
    pub const NO: Em = ("5778527486270770928", "❌");
    pub const LINK: Em = ("5877465816030515018", "🔗");
    pub const DOWN: Em = ("5886451926995833684", "⬇️");
    pub const HI: Em = ("5994750571041525522", "👋");
    pub const SHOP: Em = ("5983399041197675256", "🏪");
    pub const HELP: Em = ("5906995262378741881", "🙋");
}

/// премиум-эмодзи в тексте (parse_mode=HTML)
fn ce(e: Em) -> String {
    format!("<tg-emoji emoji-id=\"{}\">{}</tg-emoji>", e.0, e.1)
}

/// кнопка с премиум-иконкой: callback
fn bcb(e: Em, text: &str, data: &str) -> Value {
    json!({"text": text, "callback_data": data, "icon_custom_emoji_id": e.0})
}

/// кнопка с премиум-иконкой: ссылка
fn burl(e: Em, text: &str, url: &str) -> Value {
    json!({"text": text, "url": url, "icon_custom_emoji_id": e.0})
}

fn tgemoji_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r#"<tg-emoji emoji-id="\d+">(.*?)</tg-emoji>"#))
}

/// если Telegram не принял премиум-эмодзи — заменить их обычными
fn strip_premium(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("icon_custom_emoji_id");
            m.values_mut().for_each(strip_premium);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_premium),
        Value::String(s) if s.contains("<tg-emoji") => *s = tgemoji_re().replace_all(s, "$1").into_owned(),
        _ => {}
    }
}

/// длина текста, как её считает Telegram (без HTML-тегов)
fn visible_len(s: &str) -> usize {
    html_escape::decode_html_entities(&tag_re().replace_all(s, "")).encode_utf16().count()
}

/* ---------------- настройки ---------------- */

struct Cfg {
    token: String,
    api_base: String,
    site: String,
    site_resolve: Option<SocketAddr>,
    channel: String,
    support: String,
    state_dir: String,
}

fn load_dotenv() {
    let Ok(text) = std::fs::read_to_string(".env") else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let (k, v) = (k.trim(), v.trim().trim_matches('"').trim_matches('\''));
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
    }
}

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| d.to_string())
}

impl Cfg {
    fn from_env() -> Result<Self> {
        let token = std::env::var("BOT_TOKEN").context("нет BOT_TOKEN")?;
        let site_resolve = match std::env::var("SITE_RESOLVE") {
            Ok(s) if !s.trim().is_empty() => Some(s.trim().parse().context("SITE_RESOLVE: нужно вида [2a12::2]:443")?),
            _ => None,
        };
        Ok(Self {
            token,
            api_base: env_or("TG_API_BASE", "https://api.telegram.org").trim_end_matches('/').to_string(),
            site: env_or("SITE_URL", "https://coulair.ru").trim_end_matches('/').to_string(),
            site_resolve,
            channel: env_or("CHANNEL", "coulairclub").trim_start_matches('@').to_string(),
            support: env_or("SUPPORT", "coulair").trim_start_matches('@').to_string(),
            state_dir: env_or("STATE_DIR", "data"),
        })
    }
}

/* ---------------- данные ---------------- */

#[derive(Clone, Debug)]
struct Product {
    id: String,
    name: String,
    brand: String,
    price: Option<i64>,
    old_price: Option<i64>,
    sizes: Vec<String>,
    condition: String,
    features: Vec<String>,
    description: Vec<String>,
    images: Vec<String>,
    url: String,
    avito: Option<String>,
    main: bool,
}

#[derive(Default, Debug)]
struct SiteData {
    products: Vec<Product>,
    /// (заголовок, текст) из блока «Характеристики» на главной
    specs: Vec<(String, String)>,
    size_headers: Vec<String>,
    /// (ячейки, есть в наличии)
    size_rows: Vec<(Vec<String>, bool)>,
    size_note: String,
}

#[derive(Clone, Debug)]
struct Post {
    link: String,
    text: String,
}

struct App {
    cfg: Cfg,
    tg: reqwest::Client,
    web: reqwest::Client,
    site: Mutex<Option<(Instant, Arc<SiteData>)>>,
    post: Mutex<Option<(Instant, Option<Post>)>>,
    photos: Mutex<HashMap<String, String>>,
    /// кому бот не отвечает (BLOCK_FILE, по id в строке), кроме ALLOW
    blocked: std::collections::HashSet<i64>,
}

fn re(s: &str) -> Regex {
    Regex::new(s).expect("regex")
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"<[^>]+>"))
}

fn br_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?i)<br\s*/?>"))
}

/// HTML → обычный текст
fn clean(s: &str) -> String {
    let s = br_re().replace_all(s, "\n");
    let s = tag_re().replace_all(&s, "");
    let s = html_escape::decode_html_entities(&s).replace('\u{a0}', " ");
    s.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// текст → безопасно для parse_mode=HTML
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn money(v: i64) -> String {
    let s = v.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('\u{202f}');
        }
        out.push(ch);
    }
    out + " ₽"
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
    if let Some(p) = t.rfind(char::is_whitespace) {
        t.truncate(p);
    }
    t + "…"
}

impl App {
    fn abs(&self, path: &str) -> String {
        if path.starts_with("http") {
            return path.to_string();
        }
        format!("{}/{}", self.cfg.site, path.trim_start_matches("./").trim_start_matches('/'))
    }

    async fn get_text(&self, url: &str) -> Result<String> {
        let r = self.web.get(url).send().await.map_err(|e| anyhow!("{url}: {e}"))?;
        let r = r.error_for_status().map_err(|e| anyhow!("{url}: {e}"))?;
        Ok(r.text().await?)
    }

    /* ---------- сайт ---------- */

    async fn site(&self) -> Arc<SiteData> {
        let mut g = self.site.lock().await;
        if let Some((t, d)) = g.as_ref() {
            if t.elapsed() < CACHE_TTL {
                return d.clone();
            }
        }
        match self.load_site().await {
            Ok(d) => {
                let d = Arc::new(d);
                *g = Some((Instant::now(), d.clone()));
                d
            }
            Err(e) => {
                eprintln!("[site] {e:#}");
                // старые данные лучше, чем ничего; повторим через минуту
                let old = g.as_ref().map(|(_, d)| d.clone()).unwrap_or_default();
                let at = Instant::now().checked_sub(CACHE_TTL - Duration::from_secs(60)).unwrap_or_else(Instant::now);
                *g = Some((at, old.clone()));
                old
            }
        }
    }

    async fn load_site(&self) -> Result<SiteData> {
        let site = &self.cfg.site;
        let (u_index, u_main, u_cat) = (format!("{site}/"), format!("{site}/js/main.js"), format!("{site}/catalog/catalog.js"));
        let (index, main_js, catalog) = tokio::try_join!(self.get_text(&u_index), self.get_text(&u_main), self.get_text(&u_cat))?;
        let mut d = SiteData::default();

        // характеристики штанов
        if let Some(i) = index.find("<summary>Характеристики</summary>") {
            let part = &index[i..];
            let part = &part[..part.find("</details>").unwrap_or(part.len())];
            for c in re(r"(?s)<li>(.*?)</li>").captures_iter(part) {
                let li = &c[1];
                match re(r"(?s)<strong>(.*?)</strong>(.*)").captures(li) {
                    Some(m) => d.specs.push((clean(&m[1]).trim_end_matches(':').to_string(), clean(&m[2]))),
                    None => d.specs.push((String::new(), clean(li))),
                }
            }
        }

        // размерная сетка
        if let Some(i) = index.find("id=\"sizeChart\"") {
            let part = &index[i..];
            let part = &part[..part.find("</details>").unwrap_or(part.len())];
            d.size_headers = re(r"(?s)<th[^>]*>(.*?)</th>").captures_iter(part).map(|c| clean(&c[1])).collect();
            if let Some(b) = part.find("<tbody>") {
                for c in re(r"(?s)<tr([^>]*)>(.*?)</tr>").captures_iter(&part[b..]) {
                    let cells: Vec<String> = re(r"(?s)<td[^>]*>(.*?)</td>").captures_iter(&c[2]).map(|x| clean(&x[1])).collect();
                    if !cells.is_empty() {
                        d.size_rows.push((cells, c[1].contains("is-stock")));
                    }
                }
            }
            if let Some(m) = re(r#"(?s)size-table__note">(.*?)</p>"#).captures(part) {
                d.size_note = clean(&m[1]);
            }
        }

        // главный товар — штаны (CONFIG.pants в js/main.js + описание с главной)
        if let Some(c) = re(r"(?s)\bpants:\s*\{(.*?)\}").captures(&main_js) {
            let b = &c[1];
            let s = |k: &str| re(&format!(r#"\b{k}:\s*['"]([^'"]*)['"]"#)).captures(b).map(|m| m[1].to_string());
            let n = |k: &str| re(&format!(r"\b{k}:\s*(\d+)")).captures(b).and_then(|m| m[1].parse().ok());
            let sizes = re(r"\bsizes:\s*\[([^\]]*)\]")
                .captures(b)
                .map(|m| re(r#"['"]([^'"]+)['"]"#).captures_iter(&m[1]).map(|x| x[1].to_string()).collect())
                .unwrap_or_default();
            let desc = re(r#"(?s)class="hp-info__desc">(.*?)</p>"#).captures(&index).map(|m| clean(&m[1]));
            let note = re(r#"(?s)class="hp-info__note">(.*?)</p>"#).captures(&index).map(|m| clean(&m[1]));
            let mut images: Vec<String> = s("image").into_iter().collect();
            for m in re(r#"assets/pants/[\w.-]+\.(?:jpe?g|png|webp)"#).find_iter(&index) {
                if !images.iter().any(|x| x == m.as_str()) && images.len() < 6 {
                    images.push(m.as_str().to_string());
                }
            }
            d.products.push(Product {
                id: s("id").unwrap_or_else(|| "pants".into()),
                name: s("name").unwrap_or_else(|| "Горнолыжные штаны".into()),
                brand: "Coulair Club".into(),
                price: n("price"),
                old_price: n("oldPrice"),
                sizes,
                condition: note.unwrap_or_default(),
                features: d.specs.iter().map(|(h, t)| if h.is_empty() { t.clone() } else { h.clone() }).collect(),
                description: desc.into_iter().collect(),
                images,
                url: "#pants".into(),
                avito: None,
                main: true,
            });
        }

        // каталог (шлемы, ботинки…)
        let (a, z) = (catalog.find('[').context("catalog.js: нет [")?, catalog.rfind(']').context("catalog.js: нет ]")?);
        let list: Value = serde_json::from_str(&catalog[a..=z]).context("catalog.js")?;
        for p in list.as_array().into_iter().flatten() {
            let st = |k: &str| p[k].as_str().unwrap_or("").to_string();
            let arr = |k: &str| -> Vec<String> {
                p[k].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect()
            };
            if p["sold"].as_bool() == Some(true) || p["stock"].as_i64() == Some(0) {
                continue;
            }
            d.products.push(Product {
                id: st("id"),
                name: st("name"),
                brand: st("brand"),
                price: p["price"].as_i64(),
                old_price: p["oldPrice"].as_i64(),
                sizes: [st("size")].into_iter().filter(|s| !s.is_empty()).collect(),
                condition: st("condition"),
                features: arr("features"),
                description: arr("description"),
                images: arr("images"),
                url: st("url"),
                avito: Some(st("avito")).filter(|s| s.starts_with("http")),
                main: false,
            });
        }
        if d.products.is_empty() {
            return Err(anyhow!("на сайте не нашлось товаров"));
        }
        Ok(d)
    }

    /* ---------- канал: последний пост с характеристиками ---------- */

    async fn spec_post(&self) -> Option<Post> {
        let mut g = self.post.lock().await;
        if let Some((t, p)) = g.as_ref() {
            if t.elapsed() < CACHE_TTL {
                return p.clone();
            }
        }
        let file = format!("{}/specs_post.json", self.cfg.state_dir);
        let saved = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| {
            Some(Post { link: v["link"].as_str()?.to_string(), text: v["text"].as_str()?.to_string() })
        });
        let found = match self.load_spec_post().await {
            Ok(Some(p)) => {
                let _ = std::fs::create_dir_all(&self.cfg.state_dir);
                let _ = std::fs::write(&file, json!({"link": p.link, "text": p.text}).to_string());
                Some(p)
            }
            Ok(None) => saved, // пост ушёл из ленты — берём сохранённый
            Err(e) => {
                eprintln!("[channel] {e:#}");
                saved
            }
        };
        *g = Some((Instant::now(), found.clone()));
        found
    }

    async fn load_spec_post(&self) -> Result<Option<Post>> {
        let html = self.get_text(&format!("https://t.me/s/{}", self.cfg.channel)).await?;
        let post_re = re(r#"data-post="([^"]+)""#);
        let text_re = re(r#"(?s)tgme_widget_message_text[^>]*>(.*?)</div>"#);
        let mut best = None;
        for block in html.split("tgme_widget_message_wrap").skip(1) {
            let (Some(id), Some(t)) = (post_re.captures(block), text_re.captures(block)) else { continue };
            let text = clean(&t[1]);
            if text.to_lowercase().contains("характеристик") {
                best = Some(Post { link: format!("https://t.me/{}", &id[1]), text }); // лента идёт от старых к новым
            }
        }
        Ok(best)
    }

    /* ---------- Telegram ---------- */

    async fn call(&self, method: &str, body: Value) -> Result<Value> {
        match self.call_raw(method, &body).await {
            Err(e) if body.to_string().contains("emoji") => {
                eprintln!("[premium] {e:#} — шлю с обычными эмодзи");
                let mut plain = body;
                strip_premium(&mut plain);
                self.call_raw(method, &plain).await
            }
            r => r,
        }
    }

    async fn call_raw(&self, method: &str, body: &Value) -> Result<Value> {
        let url = format!("{}/bot{}/{}", self.cfg.api_base, self.cfg.token, method);
        let r = self.tg.post(&url).json(&body).send().await.map_err(|e| anyhow!("{method}: {}", e.without_url()))?;
        let v: Value = r.json().await.map_err(|e| anyhow!("{method}: {}", e.without_url()))?;
        if v["ok"].as_bool() != Some(true) {
            return Err(anyhow!("{method}: {}", v["description"]));
        }
        Ok(v["result"].clone())
    }

    async fn call_form(&self, method: &str, form: reqwest::multipart::Form) -> Result<Value> {
        let url = format!("{}/bot{}/{}", self.cfg.api_base, self.cfg.token, method);
        let r = self.tg.post(&url).multipart(form).send().await.map_err(|e| anyhow!("{method}: {}", e.without_url()))?;
        let v: Value = r.json().await.map_err(|e| anyhow!("{method}: {}", e.without_url()))?;
        if v["ok"].as_bool() != Some(true) {
            return Err(anyhow!("{method}: {}", v["description"]));
        }
        Ok(v["result"].clone())
    }

    async fn send(&self, chat: i64, text: &str, kb: Value) -> Result<()> {
        let mut body = json!({"chat_id": chat, "text": text, "parse_mode": "HTML", "link_preview_options": {"is_disabled": true}});
        if !kb.is_null() {
            body["reply_markup"] = kb;
        }
        self.call("sendMessage", body).await.map(|_| ())
    }

    async fn image(&self, url: &str) -> Result<Vec<u8>> {
        let r = self.web.get(url).send().await.map_err(|e| anyhow!("{url}: {e}"))?;
        Ok(r.error_for_status().map_err(|e| anyhow!("{url}: {e}"))?.bytes().await?.to_vec())
    }

    fn remember_photo(&self, photos: &mut HashMap<String, String>, url: &str, msg: &Value) {
        if let Some(id) = msg["photo"].as_array().and_then(|a| a.last()).and_then(|p| p["file_id"].as_str()) {
            photos.insert(url.to_string(), id.to_string());
        }
    }

    /// Фото с подписью; фото с сайта загружаем сами (Telegram может не достучаться до сайта), file_id запоминаем.
    /// Если премиум-эмодзи не приняты — повтор с обычными.
    async fn send_photo(&self, chat: i64, url: &str, caption: &str, kb: Value) -> Result<()> {
        let known = self.photos.lock().await.get(url).cloned();
        if let Some(id) = known {
            let mut body = json!({"chat_id": chat, "photo": id, "caption": caption, "parse_mode": "HTML"});
            if !kb.is_null() {
                body["reply_markup"] = kb.clone();
            }
            if self.call("sendPhoto", body).await.is_ok() {
                return Ok(());
            }
        }
        let bytes = self.image(url).await?;
        let form = |caption: &str, kb: &Value| -> Result<reqwest::multipart::Form> {
            let mut f = reqwest::multipart::Form::new()
                .text("chat_id", chat.to_string())
                .text("caption", caption.to_string())
                .text("parse_mode", "HTML");
            if !kb.is_null() {
                f = f.text("reply_markup", kb.to_string());
            }
            Ok(f.part("photo", reqwest::multipart::Part::bytes(bytes.clone()).file_name("photo.jpg").mime_str("image/jpeg")?))
        };
        let msg = match self.call_form("sendPhoto", form(caption, &kb)?).await {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[premium] {e:#} — фото с обычными эмодзи");
                let (mut c, mut k) = (Value::String(caption.to_string()), kb.clone());
                strip_premium(&mut c);
                strip_premium(&mut k);
                self.call_form("sendPhoto", form(c.as_str().unwrap_or(""), &k)?).await?
            }
        };
        self.remember_photo(&mut *self.photos.lock().await, url, &msg);
        Ok(())
    }

    async fn send_album(&self, chat: i64, urls: &[String]) -> Result<()> {
        let mut form = reqwest::multipart::Form::new().text("chat_id", chat.to_string());
        let mut media = Vec::new();
        for (i, u) in urls.iter().take(10).enumerate() {
            let known = self.photos.lock().await.get(u).cloned();
            match known {
                Some(id) => media.push(json!({"type": "photo", "media": id})),
                None => {
                    let bytes = self.image(u).await?;
                    let name = format!("p{i}");
                    form = form.part(name.clone(), reqwest::multipart::Part::bytes(bytes).file_name(format!("{name}.jpg")).mime_str("image/jpeg")?);
                    media.push(json!({"type": "photo", "media": format!("attach://{name}")}));
                }
            }
        }
        let form = form.text("media", Value::Array(media).to_string());
        let sent = self.call_form("sendMediaGroup", form).await?;
        let mut photos = self.photos.lock().await;
        for (u, m) in urls.iter().zip(sent.as_array().into_iter().flatten()) {
            self.remember_photo(&mut photos, u, m);
        }
        Ok(())
    }

    /* ---------- экраны ---------- */

    fn menu() -> Value {
        json!({
            "keyboard": [
                [{"text": BTN_PRODUCTS, "icon_custom_emoji_id": em::PRODUCTS.0}, {"text": BTN_SPECS, "icon_custom_emoji_id": em::SPECS.0}],
                [{"text": BTN_SIZES, "icon_custom_emoji_id": em::SIZES.0}, {"text": BTN_SUPPORT, "icon_custom_emoji_id": em::SUPPORT.0}],
            ],
            "resize_keyboard": true,
            "is_persistent": true,
        })
    }

    fn support_url(&self) -> String {
        format!("https://t.me/{}", self.cfg.support)
    }

    async fn start(&self, chat: i64) -> Result<()> {
        let text = format!(
            "{hi} Привет! Это бот <b>COULAIR CLUB</b> — горнолыжные штаны и экипировка.\n\n\
             {p} <b>{BTN_PRODUCTS}</b> — что сейчас в продаже\n\
             {s} <b>{BTN_SPECS}</b> — из чего сделаны штаны\n\
             {z} <b>{BTN_SIZES}</b> — как подобрать размер\n\
             {h} <b>{BTN_SUPPORT}</b> — живой ответ от нашей команды\n\n\
             {shop} Сайт: <a href=\"{site}\">{host}</a> · Канал: @{ch}",
            hi = ce(em::HI),
            p = ce(em::PRODUCTS),
            s = ce(em::SPECS),
            z = ce(em::SIZES),
            h = ce(em::SUPPORT),
            shop = ce(em::SHOP),
            site = self.cfg.site,
            host = self.cfg.site.trim_start_matches("https://"),
            ch = self.cfg.channel,
        );
        self.send(chat, &text, Self::menu()).await
    }

    async fn products(&self, chat: i64) -> Result<()> {
        let d = self.site().await;
        if d.products.is_empty() {
            return self.send(chat, "Не получилось загрузить товары с сайта. Попробуйте чуть позже или напишите в поддержку.", self.support_kb()).await;
        }
        let rows: Vec<Value> = d
            .products
            .iter()
            .map(|p| {
                let price = p.price.map(|v| format!(" · {}", money(v))).unwrap_or_default();
                let icon = if p.main { em::STAR } else { em::PRODUCTS };
                json!([bcb(icon, &format!("{}{price}", p.name), &format!("p:{}", p.id))])
            })
            .collect();
        let t = format!("{} <b>Товары COULAIR CLUB</b>\nВыберите, что посмотреть {}", ce(em::SHOP), ce(em::DOWN));
        self.send(chat, &t, json!({"inline_keyboard": rows})).await
    }

    fn card_text(p: &Product) -> String {
        let mut t = format!("<b>{}</b>", esc(&p.name));
        if !p.brand.is_empty() && !p.main {
            t += &format!("\n{}", esc(&p.brand));
        }
        t += "\n\n";
        let price = ce(em::PRICE);
        match (p.price, p.old_price) {
            (Some(v), Some(o)) if o > v => t += &format!("{price} <b>{}</b>  <s>{}</s>\n", money(v), money(o)),
            (Some(v), _) => t += &format!("{price} <b>{}</b>\n", money(v)),
            (None, _) if p.avito.is_some() => t += &format!("{price} Цена — в объявлении на Авито\n"),
            _ => {}
        }
        if !p.sizes.is_empty() {
            let label = if p.sizes.len() > 1 { "Размеры" } else { "Размер" };
            t += &format!("{} {label}: {}\n", ce(em::SIZES), esc(&p.sizes.join(", ")));
        }
        if !p.condition.is_empty() {
            let label = if p.main { ce(em::SHIP) } else { format!("{} Состояние:", ce(em::COND)) };
            t += &format!("{label} {}\n", esc(&p.condition));
        }
        if !p.features.is_empty() {
            t += "\n";
            for f in &p.features {
                t += &format!("• {}\n", esc(f));
            }
        }
        if let Some(desc) = p.description.first() {
            t += &format!("\n{}", esc(desc));
        }
        t
    }

    fn card_kb(&self, p: &Product) -> Value {
        let mut rows = vec![json!([burl(em::ORDER, "Заказать на сайте", &self.abs(&p.url))])];
        if let Some(a) = &p.avito {
            rows.push(json!([burl(em::LINK, "Купить на Авито", a)]));
        }
        if p.main {
            rows.push(json!([bcb(em::SIZES, BTN_SIZES, "sizes"), bcb(em::SPECS, BTN_SPECS, "specs")]));
        }
        if p.images.len() > 1 {
            rows.push(json!([bcb(em::PHOTO, &format!("Все фото ({})", p.images.len().min(10)), &format!("ph:{}", p.id))]));
        }
        rows.push(json!([bcb(em::BACK, "Все товары", "list"), bcb(em::SUPPORT, BTN_SUPPORT, "support")]));
        json!({"inline_keyboard": rows})
    }

    async fn product(&self, chat: i64, id: &str) -> Result<()> {
        let d = self.site().await;
        let Some(p) = d.products.iter().find(|p| p.id == id) else {
            let kb = json!({"inline_keyboard": [[bcb(em::BACK, "Все товары", "list")]]});
            return self.send(chat, &format!("{} Этого товара уже нет на сайте", ce(em::NO)), kb).await;
        };
        let text = Self::card_text(p);
        let kb = self.card_kb(p);
        if let Some(img) = p.images.first() {
            let img = self.abs(img);
            let r = if visible_len(&text) <= 1024 {
                self.send_photo(chat, &img, &text, kb.clone()).await
            } else {
                // длинная подпись не влезает — фото с названием, текст следом
                match self.send_photo(chat, &img, &format!("<b>{}</b>", esc(&p.name)), Value::Null).await {
                    Ok(()) => return self.send(chat, &text, kb).await,
                    e => e,
                }
            };
            match r {
                Ok(()) => return Ok(()),
                Err(e) => eprintln!("[photo] {}: {e:#}", p.id),
            }
        }
        self.send(chat, &text, kb).await
    }

    async fn album(&self, chat: i64, id: &str) -> Result<()> {
        let d = self.site().await;
        let Some(p) = d.products.iter().find(|p| p.id == id) else { return Ok(()) };
        let urls: Vec<String> = p.images.iter().map(|u| self.abs(u)).collect();
        if urls.len() < 2 {
            return Ok(());
        }
        self.send_album(chat, &urls).await
    }

    async fn specs(&self, chat: i64) -> Result<()> {
        let (d, post) = tokio::join!(self.site(), self.spec_post());
        let main = d.products.iter().find(|p| p.main);
        let mut t = format!("{} <b>Характеристики — {}</b>\n", ce(em::SPECS), esc(main.map(|p| p.name.as_str()).unwrap_or("горнолыжные штаны")));
        if let Some(p) = &post {
            t += &format!("\n{}\n{} <a href=\"{}\">Пост в канале</a>\n", esc(&cut(&p.text, 2000)), ce(em::LINK), p.link);
        }
        if !d.specs.is_empty() {
            t += if post.is_some() { "\n<b>С сайта:</b>\n" } else { "\n" };
            for (h, x) in &d.specs {
                if h.is_empty() {
                    t += &format!("• {}\n", esc(x));
                } else {
                    t += &format!("• <b>{}:</b> {}\n", esc(h), esc(x));
                }
            }
        }
        if post.is_none() && d.specs.is_empty() {
            t += "\nНе получилось загрузить характеристики. Напишите в поддержку — расскажем.";
        }
        let mut rows = vec![json!([bcb(em::SIZES, BTN_SIZES, "sizes")])];
        if let Some(p) = main {
            rows.push(json!([burl(em::ORDER, "Заказать на сайте", &self.abs(&p.url))]));
        }
        rows.push(json!([bcb(em::SUPPORT, BTN_SUPPORT, "support")]));
        self.send(chat, &t, json!({"inline_keyboard": rows})).await
    }

    async fn sizes(&self, chat: i64) -> Result<()> {
        let d = self.site().await;
        let mut t = format!("{} <b>Размерная сетка — штаны</b>\n", ce(em::SIZES));
        if d.size_rows.is_empty() {
            t += "\nНе получилось загрузить таблицу с сайта. Напишите в поддержку — подберём размер по росту и весу.";
        } else {
            t += "<i>замеры изделия, см</i>\n";
            let heads: Vec<String> = d.size_headers.iter().skip(1).map(|h| h.to_lowercase()).collect();
            for (cells, stock) in &d.size_rows {
                let size = cells.first().cloned().unwrap_or_default();
                let mark = ce(if *stock { em::YES } else { em::NO });
                let vals: Vec<String> = heads.iter().zip(cells.iter().skip(1)).map(|(h, v)| format!("{h} {v}")).collect();
                t += &format!("\n{mark} <b>{}</b> — {}", esc(&size), esc(&vals.join(" · ")));
            }
            t += &format!("\n\n{} — есть в наличии · {} — нет", ce(em::YES), ce(em::NO));
            if !d.size_note.is_empty() {
                t += &format!("\n\n{}", esc(&d.size_note.replace("Жирным — размеры", "Размеры")));
            }
        }
        let kb = json!({"inline_keyboard": [
            [burl(em::HELP, "Подобрать размер в поддержке", &self.support_url())],
            [bcb(em::SPECS, BTN_SPECS, "specs"), bcb(em::PRODUCTS, BTN_PRODUCTS, "list")],
        ]});
        self.send(chat, &t, kb).await
    }

    fn support_kb(&self) -> Value {
        json!({"inline_keyboard": [[burl(em::SUPPORT, &format!("Написать в поддержку @{}", self.cfg.support), &self.support_url())]]})
    }

    async fn support(&self, chat: i64) -> Result<()> {
        let t = format!(
            "{} <b>Поддержка COULAIR CLUB</b>\n\n\
             По заказу, оплате, доставке, обмену и выбору размера пишите нашей поддержке — @{}.\n\n\
             Чтобы ответили быстрее, сразу укажите номер заказа (если он есть) и ваш вопрос.",
            ce(em::SUPPORT),
            self.cfg.support
        );
        self.send(chat, &t, self.support_kb()).await
    }

    async fn other(&self, chat: i64) -> Result<()> {
        let t = format!(
            "Я умею показывать товары, характеристики и размерную сетку — выберите пункт меню {}\n\n\
             {} С вопросом лучше сразу в поддержку: @{}",
            ce(em::DOWN),
            ce(em::SUPPORT),
            self.cfg.support
        );
        self.send(chat, &t, Self::menu()).await
    }

    /* ---------- обработка апдейтов ---------- */

    fn is_blocked(&self, from: &Value) -> bool {
        from["id"].as_i64().is_some_and(|id| self.blocked.contains(&id))
    }

    async fn on_message(&self, m: &Value) -> Result<()> {
        if self.is_blocked(&m["from"]) {
            return Ok(());
        }
        let Some(chat) = m["chat"]["id"].as_i64() else { return Ok(()) };
        if m["chat"]["type"].as_str() != Some("private") {
            return Ok(());
        }
        let text = m["text"].as_str().unwrap_or("").trim();
        let cmd = text.split_whitespace().next().unwrap_or("").split('@').next().unwrap_or("").to_lowercase();
        let low = text.to_lowercase();
        match cmd.as_str() {
            "/start" | "/menu" => self.start(chat).await,
            "/products" => self.products(chat).await,
            "/specs" => self.specs(chat).await,
            "/sizes" => self.sizes(chat).await,
            "/support" | "/help" => self.support(chat).await,
            _ if text == BTN_PRODUCTS || low.contains("товар") || low.contains("каталог") => self.products(chat).await,
            _ if text == BTN_SPECS || low.contains("характеристик") => self.specs(chat).await,
            _ if text == BTN_SIZES || low.contains("размер") => self.sizes(chat).await,
            _ if text == BTN_SUPPORT || low.contains("поддержк") || low.contains("менеджер") => self.support(chat).await,
            _ => self.other(chat).await,
        }
    }

    async fn on_callback(&self, q: &Value) -> Result<()> {
        if self.is_blocked(&q["from"]) {
            return Ok(());
        }
        let _ = self.call("answerCallbackQuery", json!({"callback_query_id": q["id"]})).await;
        let Some(chat) = q["message"]["chat"]["id"].as_i64() else { return Ok(()) };
        let data = q["data"].as_str().unwrap_or("");
        match data {
            "list" => self.products(chat).await,
            "specs" => self.specs(chat).await,
            "sizes" => self.sizes(chat).await,
            "support" => self.support(chat).await,
            _ if data.starts_with("p:") => self.product(chat, &data[2..]).await,
            _ if data.starts_with("ph:") => self.album(chat, &data[3..]).await,
            _ => Ok(()),
        }
    }

    async fn setup(&self) {
        let cmds = json!({"commands": [
            {"command": "products", "description": "Товары"},
            {"command": "specs", "description": "Характеристики"},
            {"command": "sizes", "description": "Размерная сетка"},
            {"command": "support", "description": "Поддержка"},
            {"command": "start", "description": "Меню"},
        ]});
        if let Err(e) = self.call("setMyCommands", cmds).await {
            eprintln!("[setup] {e:#}");
        }
        let about = format!("Горнолыжные штаны и экипировка COULAIR CLUB. Товары, характеристики, размерная сетка и связь с поддержкой @{}.", self.cfg.support);
        let _ = self.call("setMyShortDescription", json!({"short_description": cut(&about, 120)})).await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    load_dotenv();
    let check = std::env::args().any(|a| a == "--check");
    if check && std::env::var("BOT_TOKEN").is_err() {
        std::env::set_var("BOT_TOKEN", "check");
    }
    let cfg = Cfg::from_env()?;
    let allow: Vec<i64> = env_or("ALLOW", "").split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let blocked: std::collections::HashSet<i64> = std::fs::read_to_string(env_or("BLOCK_FILE", "data/blocked.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .filter(|id| !allow.contains(id))
        .collect();
    eprintln!("[block] не отвечаю {} пользователям", blocked.len());
    let tg = reqwest::Client::builder().timeout(Duration::from_secs(70)).build()?;
    let mut web = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 coulair-bot");
    if let Some(addr) = cfg.site_resolve {
        let host = cfg.site.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
        web = web.resolve(&host, addr);
    }
    let app = Arc::new(App {
        cfg,
        tg,
        web: web.build()?,
        site: Mutex::new(None),
        post: Mutex::new(None),
        photos: Mutex::new(HashMap::new()),
        blocked,
    });

    if check {
        // без Telegram: показать, что бот достал с сайта и из канала
        let d = app.site().await;
        for p in &d.products {
            println!("=== {} ({} фото) {:?}\n{}\n", p.id, p.images.len(), app.card_kb(p)["inline_keyboard"].as_array().map(|a| a.len()), App::card_text(p));
        }
        let post = app.spec_post().await;
        println!("=== пост: {:?}\n=== specs {:?}\n=== sizes {:?}\n{:?}\n{}", post.map(|p| p.link), d.specs, d.size_headers, d.size_rows, d.size_note);
        return Ok(());
    }
    let me = app.call("getMe", json!({})).await?;
    eprintln!("coulair-bot @{} запущен", me["username"].as_str().unwrap_or("?"));
    app.setup().await;
    // прогреть кэш, чтобы первый клиент не ждал
    {
        let a = app.clone();
        tokio::spawn(async move {
            let d = a.site().await;
            let p = a.spec_post().await;
            eprintln!("[site] товаров {}, характеристик {}, строк сетки {}; пост канала: {}", d.products.len(), d.specs.len(), d.size_rows.len(), p.map(|p| p.link).unwrap_or_else(|| "нет".into()));
        });
    }

    let mut offset: i64 = 0;
    loop {
        let body = json!({"offset": offset, "timeout": 50, "allowed_updates": ["message", "callback_query"]});
        let updates = match app.call("getUpdates", body).await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[poll] {e:#}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        for u in updates.as_array().cloned().unwrap_or_default() {
            offset = offset.max(u["update_id"].as_i64().unwrap_or(0) + 1);
            let a = app.clone();
            tokio::spawn(async move {
                let r = if u["message"].is_object() {
                    a.on_message(&u["message"]).await
                } else if u["callback_query"].is_object() {
                    a.on_callback(&u["callback_query"]).await
                } else {
                    Ok(())
                };
                if let Err(e) = r {
                    eprintln!("[update] {e:#}");
                }
            });
        }
    }
}
