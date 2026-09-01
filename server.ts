import express, { type Request, type Response } from 'express';
import multer from 'multer';
import got from 'got';
import HttpAgent, { HttpsAgent } from 'agentkeepalive';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const TARGET_URL = "https://register.tpech.org/";
const LOGIN_URL = "https://register.tpech.org/login";


// ⚡ 效能優化：啟用 Keep-Alive 重用 TCP/TLS 連線，節省 30ms 握手耗時
const keepaliveAgent = {
    http: new HttpAgent({ keepAlive: true, maxSockets: 100 }),
    https: new HttpsAgent({ keepAlive: true, maxSockets: 100 })
};

// 記憶體快取 (替代 GAS 的 CacheService)
const logCache = new Map<string, string[]>();
const fileCache = new Map<string, Buffer>();

function writeLogToCache(taskId: string, msg: string) {
    if (!taskId) return;
    const logs = logCache.get(taskId) || [];
    logs.push(msg);
    logCache.set(taskId, logs);
}

// 供前端輪詢讀取 Log API (支持 query ?taskId=... 與 path /:taskId)
const handleGetLogs = (req: Request, res: Response) => {
    const taskId = (req.params.taskId || req.query.taskId) as string;
    if (!taskId || !logCache.has(taskId)) {
        return res.json([]);
    }
    const logs = logCache.get(taskId) || [];
    logCache.delete(taskId); // 讀取後即移除，避免重複印出
    res.json(logs);
};

app.get('/api/logs', handleGetLogs);
app.get('/api/logs/:taskId', handleGetLogs);

// 階段 1：接收表單並預先驗證身份 (替代 processSubmission)
app.post('/api/process-submission', upload.single('excelFile'), async (req: Request, res: Response) => {

    const taskId = "TASK_" + Date.now();

    try {
        const file = req.file;
        if (!file) {
            return res.json({ success: false, error: "未上傳 Excel 檔案！", logs: executionLogs });
        }

        const fileId = "FILE_" + Date.now();
        fileCache.set(fileId, file.buffer);

        const config = {
            retryInterval: req.body.retryInterval,
            retryCount: req.body.retryCount,
            targetTimeStr: req.body.targetTimeStr,
            districtId: req.body.districtId,
            churchId: req.body.churchId,
            authMode: req.body.authMode,
            cookieSession: req.body.cookieSession,
            cookieCf: req.body.cookieCf,
            loginEmail: req.body.loginEmail,
            loginPassword: req.body.loginPassword,
            offsetSeconds: parseFloat(req.body.offsetSeconds) || 0.1,
            validatedCookieHeader: ""
        };

        let cookieHeader = "";

        if (config.authMode === "account") {
            pushLog(taskId, "INFO", "🔑 開始發送帳號密碼驗證...");
            const loginResult = await performLogin(taskId, LOGIN_URL, config.loginEmail, config.loginPassword);

            if (!loginResult.success) {
                return res.json({
                    success: false,
                    error: loginResult.error || "❌ 帳號或密碼錯誤，登入失敗！請檢查後重試。",
                    logs: executionLogs
                });
            }
            cookieHeader = loginResult.cookieHeader || "";
            pushLog(taskId, "SUCCESS", "✅ 帳密驗證成功，取得 Cookie Session。");
        } else {
            cookieHeader = `_session=${config.cookieSession}`;
            if (config.cookieCf) cookieHeader += `; cf_clearance=${config.cookieCf}`;

            pushLog(taskId, "INFO", "🔍 正在測試 Cookie 是否有效...");
            const testRes = await got.get(TARGET_URL, {
                headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0" },
                throwHttpErrors: false,
                followRedirect: false,
                agent: keepaliveAgent
            });

            const statusCode = testRes.statusCode;
            if (statusCode === 302 || statusCode === 401 || statusCode === 403) {
                return res.json({
                    success: false,
                    error: "❌ Cookie 已失效或過期！請重新抓取 _session / cf_clearance。",
                    logs: executionLogs
                });
            }
            pushLog(taskId, "SUCCESS", "✅ Cookie 測試有效！");
        }

        config.validatedCookieHeader = cookieHeader;
        pushLog(taskId, "INFO", "📁 Excel 報名表單已載入記憶體暫存...");

        return res.json({
            success: true,
            config: config,
            taskId: taskId,
            fileId: fileId,
            logs: executionLogs
        });

    } catch (e: any) {
        pushLog(taskId, "ERROR", e.toString());
        return res.json({ success: false, error: "驗證過程發生例外錯誤: " + e.toString(), logs: executionLogs });
    }
});

// 階段 2：核心搶票連擊發射 (替代 executeSniper)
app.post('/api/execute-sniper', async (req: Request, res: Response) => {
    const taskId = req.body.taskId as string;
    const fileId = req.body.fileId as string;
    const config = req.body.config || {};
    const cookieHeader = config.validatedCookieHeader || req.body.cookieHeader;
    const districtId = config.districtId || req.body.districtId;
    const churchId = config.churchId || req.body.churchId;
    const retryInterval = config.retryInterval || req.body.retryInterval;
    const retryCount = config.retryCount || req.body.retryCount;
    const excelBuffer = fileCache.get(fileId) || (fileId ? fileCache.get(taskId) : undefined);

    pushLog(taskId, "START", "🚀 開始執行後端秒殺連擊...");


    const MAX_RETRIES = retryCount ?? 15;
    const RETRY_INTERVAL_MS = retryInterval ?? 100;

    try {
        if (!excelBuffer) {
            pushLog(taskId, "ERROR", "❌ 無法讀取 Excel 檔案 Buffer");
            return res.json({ success: false, logs: executionLogs });
        }

        let isSuccess = false;
        let conferenceSlug: string | null = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            pushLog(taskId, "INFO", "    ");
            pushLog(taskId, "INFO", `🚀 第 ${attempt} 次嘗試搶票...`);

            if (!conferenceSlug) {
                pushLog(taskId, "INFO", "🔍 正在向首頁請求最新 Slug...");
                conferenceSlug = await fetchLatestConferenceSlug(cookieHeader);

                if (!conferenceSlug) {
                    pushLog(taskId, "WARN", `⚠️ 第 ${attempt} 次嘗試：首頁尚未開放，${RETRY_INTERVAL_MS}ms 後重試...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
                    continue;
                }
                pushLog(taskId, "INFO", `✅ 成功鎖定動態 Slug: ${conferenceSlug}`);
            }

            const INFO_URL = `https://register.tpech.org/conferences/${conferenceSlug}`;
            const REGISTER_URL = `https://register.tpech.org/conferences/${conferenceSlug}/register`;
            const CONFIRM_URL = `https://register.tpech.org/conferences/${conferenceSlug}/register/confirm`;

            pushLog(taskId, "INFO", `發送第一階段請求...`);
            // Step 1 GET: 抓取 CSRF Token
            const resRegister = await got.get(INFO_URL, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Cookie": cookieHeader,
                    "Referer": TARGET_URL
                },
                throwHttpErrors: false,
                agent: keepaliveAgent
            });
            const htmlReg = resRegister.body;
            const csrfToken = extractInputValue(htmlReg, "_token");

            if (!csrfToken) {
                pushLog(taskId, "WARN", `⚠️ 第 ${attempt} 次嘗試：CSRF Token 取得失敗，${RETRY_INTERVAL_MS}ms 後重試...`);
                conferenceSlug = null;
                await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
                continue;
            }

            // Step 1 POST: 上傳檔案(使用 Node 原生 FormData 與 Blob)
            const fileBlob = new Blob([new Uint8Array(excelBuffer)], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });

            const formStep1 = new FormData();
            formStep1.append("_token", csrfToken);
            formStep1.append("district_id", districtId);
            formStep1.append("church_id", churchId);
            formStep1.append("registration_form", fileBlob, 'form.xlsx');

            pushLog(taskId, "INFO", `token:${csrfToken}`);

            const step1Response = await got.post(REGISTER_URL, {
                body: formStep1,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Cookie": cookieHeader,
                    "Referer": REGISTER_URL
                    // ⚠️ 自動處理 Content-Type，不需再傳入 ...formStep1.getHeaders()
                },
                throwHttpErrors: false,
                agent: keepaliveAgent
            });

            const htmlConfirm = step1Response.body;
            const previewToken = extractInputValue(htmlConfirm, "preview_token");

            if (!previewToken) {
                pushLog(taskId, "WARN", `⚠️ 第 ${attempt} 次嘗試：第一階段表單送出無回應或被退回，${RETRY_INTERVAL_MS}ms 後補刀...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
                continue;
            }

            pushLog(taskId, "INFO", `preview_token:${previewToken}`);

            // Step 2 POST: 最終確認
            const step2CsrfToken = extractInputValue(htmlConfirm, "_token") || csrfToken;
            const formStep2 = new FormData();
            formStep2.append("_token", step2CsrfToken);
            formStep2.append("preview_token", previewToken);

            pushLog(taskId, "INFO", `發送最終確認請求...`);
            const finalResponse = await got.post(CONFIRM_URL, {
                body: formStep2,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Cookie": cookieHeader,
                    "Referer": REGISTER_URL
                    // ⚠️ 自動處理 Content-Type，不需再傳入 ...formStep2.getHeaders()
                },
                throwHttpErrors: false,
                agent: keepaliveAgent
            });

            if (finalResponse.statusCode === 200 || finalResponse.statusCode === 302) {
                pushLog(taskId, "SUCCESS", "🎉🎉🎉 恭喜！秒殺成功，已完成最終報名送出！");
                isSuccess = true;
                break;
            } else {
                pushLog(taskId, "ERROR", `❌ 第二階段失敗，HTTP Status: ${finalResponse.statusCode}`);
                await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
            }
        }

        return res.json({ success: isSuccess, logs: executionLogs });

    } catch (e: any) {
        pushLog(taskId, "ERROR", `❌ 發生異常: ${e.toString()}`);
        return res.json({ success: false, logs: executionLogs });
    }
});


async function fetchLatestConferenceSlug(cookieHeader: string): Promise<string | null> {
    try {
        const response = await got.get(TARGET_URL, {
            headers: {
                "Cookie": cookieHeader || "",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            throwHttpErrors: false,
            agent: keepaliveAgent
        });

        const html = response.body;

        const regex = /href=["']https:\/\/register\.tpech\.org\/conferences\/([^"']*sister-blending-conference[^"']*)["']/i;
        const match = html.match(regex);
        if (match && match[1]) return match[1];

        const altRegex = /href=["']\/conferences\/([^"']*sister-blending-conference[^"']*)["']/i;
        const altMatch = html.match(altRegex);
        if (altMatch && altMatch[1]) return altMatch[1];

    } catch (e) {
        console.error("fetchLatestConferenceSlug Error:", e);
    }
    return null;
}

async function performLogin(taskId: string, loginUrl: string, email: string, password: string) {
    try {
        pushLog(taskId, "INFO", "開始抓取登入頁面 CSRF Token...");

        const resGet = await got.get(loginUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            },
            throwHttpErrors: false,
            followRedirect: true,
            agent: keepaliveAgent
        });

        const htmlGet = resGet.body;
        const token = extractInputValue(htmlGet, "_token");
        pushLog(taskId, "INFO", `成功取得登入 Token: ${token}`);

        const rawGetCookies = resGet.headers["set-cookie"];
        const initialCookieStr = rawGetCookies ? rawGetCookies.join("; ") : "";

        if (!token) {
            return { success: false, error: "無法取得登入頁面的 CSRF Token，請確認網址是否正確。" };
        }

        // 1. 使用原生 globalThis.FormData
        const form = new FormData();
        form.append("_token", token);
        form.append("email", email);
        form.append("password", password);

        // 2. got 會自動處理原生 FormData 的 Header
        const resPost = await got.post(loginUrl, {
            body: form,
            headers: {
                "Cookie": initialCookieStr,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": loginUrl,
                "Origin": "https://register.tpech.org"
                // ⚠️ 注意：不要在這裡加 ...form.getHeaders()
            },
            throwHttpErrors: false,
            followRedirect: false,
            agent: keepaliveAgent
        });

        const statusCode = resPost.statusCode;
        const postCookies = resPost.headers["set-cookie"];
        const locationHeader = resPost.headers["location"];

        if ((statusCode === 302 || statusCode === 301) && postCookies) {
            if (locationHeader && !locationHeader.includes("/login")) {
                return {
                    success: true,
                    cookieHeader: postCookies.join("; ")
                };
            }
        }

        const responseHtml = resPost.body;
        if (responseHtml.includes('name="password"') || statusCode === 200) {
            return { success: false, error: "登入失敗：網站退回登入頁（請確認帳密或是否需過驗證碼）。" };
        }

    } catch (e: any) {
        return { success: false, error: "登入發送過程異常: " + e.toString() };
    }

    return { success: false, error: "登入未成功，請嘗試改用「Cookie 認證模式」。" };
}

function extractInputValue(html: string, name: string): string | null {
    const regex = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`, "i");
    const match = html.match(regex);
    if (match) return match[1] ?? null;

    const regexAlt = new RegExp(`value=["']([^"']+)["'][^>]*name=["']${name}["']`, "i");
    const matchAlt = html.match(regexAlt);
    return matchAlt ? matchAlt[1] ?? null : null;
}

const executionLogs: string[] = [];
function pushLog(taskId: string, type: string, msg: string) {
    const now = new Date();
    const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const formatted = `[${time}] [${type}] ${msg}`;
    console.log(formatted);
    executionLogs.push(formatted);
    writeLogToCache(taskId, formatted);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});