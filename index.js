/**
 * Scene Image → ComfyUI
 *
 * 给 SillyTavern 的 ComfyUI 生图后端补上「场景图通道」。
 *
 * 背景：ST 原生只有 %char_avatar%（角色卡头像）和 %user_avatar%（用户头像）
 * 两条图片通道，且都只读头像文件。角色立绘 / 世界观场景图通常是以
 * ![](url) 或 <img src="url"> 的形式插在消息正文里的，ST 拿不到。
 *
 * 本扩展在 fetch 层拦截发往 /api/sd/comfy/generate 的请求，把工作流里
 * 的 "%scene_image%" 占位符替换成：
 *   1) 聊天里最新一张（够大的）图片；抓不到就
 *   2) 角色卡头像；再抓不到就
 *   3) 1x1 透明 PNG（保持 ComfyUI 不报错）
 *
 * 不改 ST 核心文件，全部逻辑在本目录内。
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'scene-image-comfy';

/** 工作流里使用的占位符（含两侧双引号，和 ST 原生占位符写法一致） */
const PLACEHOLDER_KEY = '"%scene_image%"';

/** 1x1 透明 PNG，与 ST 内部 PNG_PIXEL 完全一致 */
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const DEFAULT_SETTINGS = {
    /** 总开关 */
    enabled: true,
    /** true = 优先聊天图；false = 直接用角色卡头像 */
    preferChatImage: true,
    /** 小于这个边长的图忽略（避免抓到表情包 / 内联小图标） */
    minSize: 128,
    /** 控制台调试日志 */
    debug: false,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

const settings = getSettings();

function log(...args) {
    if (settings.debug) {
        console.log('[scene-image-comfy]', ...args);
    }
}

/* ------------------------------------------------------------------ */
/* 图片 → base64                                                       */
/* ------------------------------------------------------------------ */

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : null);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * 把任意图片地址（http(s) / 相对路径 / blob: / data:）转成裸 base64。
 * @returns {Promise<string|null>}
 */
async function urlToBase64(url) {
    if (!url) return null;

    if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        if (comma < 0) return null;
        const header = url.slice(0, comma);
        if (!header.includes('base64')) return null;
        return url.slice(comma + 1);
    }

    try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
            log('fetch image failed', url, response.status);
            return null;
        }
        const blob = await response.blob();
        if (blob.type && !blob.type.startsWith('image/')) {
            log('not an image', url, blob.type);
            return null;
        }
        return await blobToBase64(blob);
    } catch (error) {
        log('fetch image threw', url, error);
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 抓图                                                                */
/* ------------------------------------------------------------------ */

/**
 * 在聊天记录的正文区域里找最新一张「够大」的图。
 * 只看 .mes_text，避免抓到头像、表情包栏、扩展注入的小图标。
 * @returns {string|null} 图片地址
 */
function findLatestChatImage() {
    const nodes = document.querySelectorAll('#chat .mes .mes_text img');
    for (let i = nodes.length - 1; i >= 0; i--) {
        const img = nodes[i];
        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (!src) continue;
        if (src.startsWith('data:image/svg')) continue;

        // 尺寸过滤：已加载的图才判断，未加载（0）先放行
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        if (width > 0 && width < settings.minSize) continue;
        if (height > 0 && height < settings.minSize) continue;

        return src;
    }
    return null;
}

/**
 * 角色卡头像地址（群聊取最后一条非 system 消息的发言角色）。
 * @returns {string|null}
 */
function getCharacterAvatarUrlFallback() {
    const context = getContext();
    try {
        if (context.groupId) {
            const chat = context.chat || [];
            for (let i = chat.length - 1; i >= 0; i--) {
                const message = chat[i];
                if (message && !message.is_system && message.original_avatar) {
                    return `/characters/${encodeURIComponent(message.original_avatar)}`;
                }
            }
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return `/characters/${encodeURIComponent(character.avatar)}`;
        }
    } catch (error) {
        log('avatar fallback failed', error);
    }
    return null;
}

/**
 * 解析出最终要用的 base64。
 * @returns {Promise<string>}
 */
async function resolveSceneImage() {
    let base64 = null;
    let sourceUrl = null;
    let sourceLabel = '';

    if (settings.preferChatImage) {
        const chatUrl = findLatestChatImage();
        if (chatUrl) {
            base64 = await urlToBase64(chatUrl);
            if (base64) {
                sourceUrl = chatUrl;
                sourceLabel = '聊天图';
            }
        }
    }

    if (!base64) {
        const avatarUrl = getCharacterAvatarUrlFallback();
        if (avatarUrl) {
            base64 = await urlToBase64(avatarUrl);
            if (base64) {
                sourceUrl = avatarUrl;
                sourceLabel = '角色头像';
            }
        }
    }

    if (!base64) {
        base64 = PNG_PIXEL;
        sourceUrl = null;
        sourceLabel = '占位图';
    }

    updatePreview(sourceUrl, sourceLabel, base64);
    return base64;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function updatePreview(sourceUrl, sourceLabel, base64) {
    const status = document.getElementById('sic_status');
    const preview = document.getElementById('sic_preview');

    if (status) {
        status.textContent = sourceLabel ? `${sourceLabel}（${Math.round((base64.length * 3) / 4 / 1024)} KB）` : '尚未抓取';
    }
    if (preview) {
        if (sourceUrl) {
            preview.src = sourceUrl;
            preview.style.display = 'block';
        } else {
            preview.removeAttribute('src');
            preview.style.display = 'none';
        }
    }
}

function addUI() {
    if (document.getElementById('sic_enabled')) return;

    const html = `
    <div class="scene-image-comfy">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Scene Image → ComfyUI</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="sic_enabled">
                    <input type="checkbox" id="sic_enabled">
                    <span>启用：点生图时抓聊天里最新一张图喂给 ComfyUI</span>
                </label>
                <label class="checkbox_label" for="sic_prefer_chat">
                    <input type="checkbox" id="sic_prefer_chat">
                    <span>优先用聊天图；抓不到再退回角色卡头像</span>
                </label>
                <label class="checkbox_label" for="sic_debug">
                    <input type="checkbox" id="sic_debug">
                    <span>控制台调试日志</span>
                </label>
                <div class="sic-preview-row">
                    <span>最近抓取：</span><span id="sic_status">尚未抓取</span>
                </div>
                <img id="sic_preview" class="sic-preview" alt="" />
                <small>工作流里对应占位符：<code>"%scene_image%"</code></small>
            </div>
        </div>
    </div>`;

    jQuery('#extensions_settings2').append(html);

    const enabled = jQuery('#sic_enabled');
    const preferChat = jQuery('#sic_prefer_chat');
    const debug = jQuery('#sic_debug');

    enabled.prop('checked', settings.enabled);
    preferChat.prop('checked', settings.preferChatImage);
    debug.prop('checked', settings.debug);

    enabled.on('change', () => {
        settings.enabled = !!enabled.prop('checked');
        saveSettingsDebounced();
    });
    preferChat.on('change', () => {
        settings.preferChatImage = !!preferChat.prop('checked');
        saveSettingsDebounced();
    });
    debug.on('change', () => {
        settings.debug = !!debug.prop('checked');
        saveSettingsDebounced();
    });
}

/* ------------------------------------------------------------------ */
/* fetch 拦截                                                          */
/* ------------------------------------------------------------------ */

const originalFetch = window.fetch.bind(window);

window.fetch = async function (input, init) {
    let requestUrl = '';
    try {
        requestUrl = typeof input === 'string'
            ? input
            : (input && typeof input === 'object' && 'url' in input ? String(input.url) : '');
    } catch {
        requestUrl = '';
    }

    const isTarget = requestUrl.includes('/api/sd/comfy/generate');
    const method = String(init?.method || '').toUpperCase();

    if (!isTarget || method !== 'POST' || typeof init?.body !== 'string' || !settings.enabled) {
        return originalFetch(input, init);
    }

    try {
        const payload = JSON.parse(init.body);
        if (typeof payload?.prompt !== 'string' || !payload.prompt.includes(PLACEHOLDER_KEY)) {
            return originalFetch(input, init);
        }

        const base64 = await resolveSceneImage();
        payload.prompt = payload.prompt.split(PLACEHOLDER_KEY).join(JSON.stringify(base64));
        init = { ...init, body: JSON.stringify(payload) };
        log(`injected ${base64.length} chars`);
    } catch (error) {
        console.warn('[scene-image-comfy] 注入失败，按原请求继续：', error);
    }

    return originalFetch(input, init);
};

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

jQuery(() => {
    addUI();
    console.log('[scene-image-comfy] loaded, placeholder =', PLACEHOLDER_KEY);
});
