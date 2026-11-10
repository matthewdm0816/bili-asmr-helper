// ==UserScript==
// @name         Bilibili 音量突破与悬浮控制 (Apeiria终极版)
// @namespace    http://tampermonkey.net/
// @version      0.8
// @description  突破B站音量限制，修复音频劫持导致的无声问题，竖版悬浮音量条 + A-B时间段循环 + 声道控制 + 睡眠定时，Apeiria全程护航！
// @author       Apeiria
// @match        *://*.bilibili.com/video/*
// @match        *://*.bilibili.com/bangumi/play/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log("[Apeiria] 正在为你加载终极版音量控制小组件... 🐾");

    let globalAudioCtx = null;
    let globalGainNode = null;
    let globalCompressor = null; // limiter's compressor, polled for the gain-reduction indicator
    let compressorCreatedAt = 0; // performance.now() when the compressor was created
    let limiterPath = null;      // output gain of the limiter branch (1 above 0 dB, else 0)
    let bypassPath = null;       // output gain of the direct branch (1 at ≤ 0 dB, else 0)
    let channelMatrix = null;    // four GainNodes of the L/R mixing matrix
    let loopFadeGain = null;     // short fades at A-B loop seams
    let sleepGain = null;        // long fade-out of the sleep timer
    let currentVolume = 1.0; // linear multiplier fed to GainNode

    // Slider works in dB; GainNode itself is a linear multiplier: gain = 10^(dB/20)
    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    // Peak limiter after the gain stage. Without it, samples beyond ±1.0 are hard-clipped by the
    // output device, which is the crackling heard at high gain.
    // DynamicsCompressorNode applies automatic makeup gain (Web Audio spec: (1 / curve(0 dBFS))^0.6),
    // which would push peaks back up, so a trailing GainNode cancels it.
    // The compressor cannot catch very short transients (e.g. single-sample clicks), so a final
    // WaveShaper soft clipper catches the residue: identity below 0.8, smooth saturation towards 1.0 above.
    const LIMITER_THRESHOLD_DB = -6;
    const LIMITER_RATIO = 20;
    const SHAPER_RANGE = 4; // shaper input is pre-scaled by 1/SHAPER_RANGE so it covers ±4.0
    function softClip(y) {
        const a = Math.abs(y);
        if (a <= 0.8) return y;
        return Math.sign(y) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    }
    function createLimiter(ctx) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = LIMITER_THRESHOLD_DB;
        comp.knee.value = 0;
        comp.ratio.value = LIMITER_RATIO;
        comp.attack.value = 0;
        comp.release.value = 0.2;
        const curveAt0dB = LIMITER_THRESHOLD_DB * (1 - 1 / LIMITER_RATIO);
        const makeupCancel = ctx.createGain();
        makeupCancel.gain.value = Math.pow(10, curveAt0dB * 0.6 / 20) / SHAPER_RANGE;
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(4097);
        for (let i = 0; i < curve.length; i++) {
            curve[i] = softClip((i / (curve.length - 1) * 2 - 1) * SHAPER_RANGE);
        }
        shaper.curve = curve;
        comp.connect(makeupCancel);
        makeupCancel.connect(shaper);
        return { comp, output: shaper };
    }

    // Stereo mixing matrix: outL = LL*L + RL*R, outR = LR*L + RR*R (used for mono mix and L/R balance).
    // The input node forces 2 channels with 'speakers' up-mixing, so a mono source feeds both sides
    // instead of leaving the right channel silent.
    function createChannelStage(ctx) {
        const input = ctx.createGain();
        input.channelCount = 2;
        input.channelCountMode = 'explicit';
        input.channelInterpretation = 'speakers';
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        input.connect(splitter);
        const matrix = {};
        for (const [name, from, to] of [['LL', 0, 0], ['RL', 1, 0], ['LR', 0, 1], ['RR', 1, 1]]) {
            const g = ctx.createGain();
            splitter.connect(g, from);
            g.connect(merger, 0, to);
            matrix[name] = g;
        }
        return { input, output: merger, matrix };
    }

    // Signal chain, built once per AudioContext:
    // video source → volume gain ─┬→ limiter → limiterPath ─┬→ channel matrix → loop fade → sleep fade → speakers
    //                             └──────────→ bypassPath ──┘
    // At ≤ 0 dB the signal cannot exceed ±1.0, so it takes the bypass path and is left untouched.
    function buildAudioGraph(ctx) {
        globalGainNode = ctx.createGain();
        globalGainNode.gain.value = currentVolume;
        const limiter = createLimiter(ctx);
        globalCompressor = limiter.comp;
        compressorCreatedAt = performance.now();
        limiterPath = ctx.createGain();
        bypassPath = ctx.createGain();
        const channels = createChannelStage(ctx);
        channelMatrix = channels.matrix;
        loopFadeGain = ctx.createGain();
        sleepGain = ctx.createGain();

        globalGainNode.connect(limiter.comp);
        limiter.output.connect(limiterPath);
        limiterPath.connect(channels.input);
        globalGainNode.connect(bypassPath);
        bypassPath.connect(channels.input);
        channels.output.connect(loopFadeGain);
        loopFadeGain.connect(sleepGain);
        sleepGain.connect(ctx.destination);
        applyChannelSettings(true);
        applyLimiterBypass(true);
    }

    function isLimiterBypassed() {
        return currentVolume <= 1;
    }

    // Crossfade between the limiter path and the bypass path (30 ms, avoids clicks when crossing 0 dB)
    function applyLimiterBypass(immediate) {
        if (!limiterPath) return;
        const bypass = isLimiterBypassed();
        if (immediate) {
            limiterPath.gain.value = bypass ? 0 : 1;
            bypassPath.gain.value = bypass ? 1 : 0;
        } else {
            rampParam(limiterPath.gain, bypass ? 0 : 1, 0, 0.03);
            rampParam(bypassPath.gain, bypass ? 1 : 0, 0, 0.03);
        }
    }

    // Ramp an AudioParam from its current value to target, starting after delay seconds
    function rampParam(param, target, delay, duration) {
        const now = globalAudioCtx.currentTime;
        const v = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(v, now);
        param.setValueAtTime(v, now + delay);
        param.linearRampToValueAtTime(target, now + delay + duration);
    }

    // Persistent settings in the page's localStorage
    const STORE_VOLUME = 'apeiria-volume-db';       // last used dB, global fallback
    const STORE_UP_VOLUME = 'apeiria-up-volume-db'; // { uploaderMid: dB }
    const STORE_LOOPS = 'apeiria-ab-loops';         // { pageKey: { a, b } }
    function loadMap(key) {
        const raw = localStorage.getItem(key);
        return raw === null ? {} : JSON.parse(raw);
    }
    function saveMap(key, map) {
        localStorage.setItem(key, JSON.stringify(map));
    }

    // 1. 制造Apeiria的魔法悬浮窗 UI（竖排版：标签在上、滑条居中、按钮垫底）
    const container = document.createElement('div');
    container.style.cssText = `
        position: fixed;
        right: 0;
        top: 30%;
        transform: translateY(-50%);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(255, 255, 255, 0.95);
        border: 2px solid #fb7299;
        border-right: none;
        border-radius: 20px 0 0 20px;
        padding: 10px 5px;
        box-shadow: -2px 2px 10px rgba(251, 114, 153, 0.3);
        transition: all 0.3s ease;
        font-family: sans-serif;
    `;

    const toggleBtn = document.createElement('div');
    toggleBtn.innerHTML = '🔊';
    toggleBtn.style.cssText = `
        cursor: pointer;
        font-size: 20px;
        user-select: none;
        margin-top: 8px;
    `;

    const sliderWrapper = document.createElement('div');
    sliderWrapper.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        overflow: hidden;
        transition: height 0.3s ease;
        height: 196px;
    `;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.setAttribute('orient', 'vertical'); // Firefox 认这个属性，Chrome 会无视，两边都兼容
    slider.min = '-6';  // ≈ ×0.5
    slider.max = '26';  // ≈ ×20
    slider.step = '0.5';
    slider.value = '0';
    slider.style.cssText = `
        writing-mode: vertical-lr;
        direction: rtl;
        width: 24px;
        height: 130px;
        accent-color: #fb7299;
        cursor: pointer;
    `;

    const label = document.createElement('span');
    label.style.cssText = `
        margin-bottom: 2px;
        color: #fb7299;
        font-weight: bold;
        font-size: 12px;
        text-align: center;
    `;

    function updateVolumeLabel(db) {
        const sign = db > 0 ? '+' : '';
        label.innerText = sign + db.toFixed(1) + ' dB\n×' + dbToGain(db).toFixed(1);
    }

    // Limiter activity line: how many dB the limiter is currently pulling down
    const limiterLabel = document.createElement('span');
    limiterLabel.innerText = '限幅 0.0 dB';
    limiterLabel.title = '限幅器当前压低的音量；持续变橙说明再往上推只会让安静部分变响。≤ 0 dB 时限幅器不工作，显示“关”';
    limiterLabel.style.cssText = `
        margin-bottom: 6px;
        color: #bbb;
        font-size: 10px;
        white-space: nowrap;
        text-align: center;
    `;

    sliderWrapper.appendChild(label);
    sliderWrapper.appendChild(limiterLabel);
    sliderWrapper.appendChild(slider);
    container.appendChild(sliderWrapper);
    container.appendChild(toggleBtn);

    // 2. A-B 循环的 UI：三个小圆钮 + 状态行
    function makeAbBtn(text) {
        const b = document.createElement('div');
        b.innerText = text;
        b.style.cssText = `
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 1.5px solid #fb7299;
            color: #fb7299;
            background: #fff;
            font-size: 11px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            user-select: none;
            transition: all 0.2s ease;
        `;
        return b;
    }

    const abRow = document.createElement('div');
    abRow.style.cssText = `
        display: flex;
        gap: 5px;
        margin-top: 8px;
        align-items: center;
    `;

    const btnA = makeAbBtn('A');
    const btnB = makeAbBtn('B');
    const btnClear = makeAbBtn('✕');
    btnClear.style.fontSize = '10px';

    const abStatus = document.createElement('div');
    abStatus.innerText = 'A-B 关';
    abStatus.style.cssText = `
        margin-top: 5px;
        font-size: 10px;
        color: #999;
        white-space: nowrap;
        text-align: center;
    `;

    abRow.appendChild(btnA);
    abRow.appendChild(btnB);
    abRow.appendChild(btnClear);
    container.appendChild(abRow);
    container.appendChild(abStatus);

    // 2.5 “更多”选项：默认收起，展开后是 单声道 / 左右平衡 / 睡眠定时
    function makePillBtn(text) {
        const b = document.createElement('div');
        b.innerText = text;
        b.style.cssText = `
            border: 1.5px solid #fb7299;
            border-radius: 10px;
            color: #fb7299;
            background: #fff;
            font-size: 10px;
            padding: 2px 7px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: all 0.2s ease;
        `;
        return b;
    }
    function setPillActive(b, on) {
        b.style.background = on ? '#fb7299' : '#fff';
        b.style.color = on ? '#fff' : '#fb7299';
    }

    const moreRow = document.createElement('div');
    moreRow.style.cssText = `
        display: flex;
        gap: 4px;
        margin-top: 6px;
        align-items: center;
        font-size: 10px;
        user-select: none;
    `;
    const moreBtn = document.createElement('span');
    moreBtn.innerText = '⚙ 更多 ◂';
    moreBtn.style.cssText = 'color: #999; cursor: pointer; white-space: nowrap;';
    const sleepBadge = document.createElement('span'); // sleep countdown, visible even when the panel is collapsed
    sleepBadge.style.cssText = 'color: #fb7299; font-weight: bold; white-space: nowrap; display: none;';
    moreRow.appendChild(moreBtn);
    moreRow.appendChild(sleepBadge);

    // Flyout to the left of the strip, so opening it does not make the fixed strip taller
    const optionsPanel = document.createElement('div');
    optionsPanel.style.cssText = `
        display: none;
        position: absolute;
        right: calc(100% + 6px);
        bottom: 0;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        background: rgba(255, 255, 255, 0.95);
        border: 2px solid #fb7299;
        border-radius: 12px;
        padding: 8px 6px;
        box-shadow: -2px 2px 10px rgba(251, 114, 153, 0.3);
    `;

    const monoBtn = makePillBtn('单声道');
    monoBtn.title = '把左右声道混在一起，只戴一只耳机时用';

    const balanceLabel = document.createElement('div');
    balanceLabel.style.cssText = 'font-size: 10px; color: #999; white-space: nowrap;';

    const balanceSlider = document.createElement('input');
    balanceSlider.type = 'range';
    balanceSlider.min = '-100';
    balanceSlider.max = '100';
    balanceSlider.step = '5';
    balanceSlider.value = '0';
    balanceSlider.title = '左右平衡，双击回到居中';
    balanceSlider.style.cssText = `
        width: 70px;
        margin: 0;
        accent-color: #fb7299;
        cursor: pointer;
    `;

    const sleepBtn = makePillBtn('💤 定时 关');
    sleepBtn.title = '点击切换：关 → 15 → 30 → 60 分钟；最后 2 分钟渐弱后暂停';

    optionsPanel.appendChild(monoBtn);
    optionsPanel.appendChild(balanceLabel);
    optionsPanel.appendChild(balanceSlider);
    optionsPanel.appendChild(sleepBtn);
    container.appendChild(moreRow);
    container.appendChild(optionsPanel);
    document.body.appendChild(container);

    let optionsOpen = false;
    moreBtn.onclick = () => {
        optionsOpen = !optionsOpen;
        optionsPanel.style.display = optionsOpen ? 'flex' : 'none';
        moreBtn.innerText = optionsOpen ? '⚙ 收起 ▸' : '⚙ 更多 ◂';
    };

    // 3. A-B 循环核心逻辑
    let loopA = null;       // 循环起点（秒）
    let loopB = null;       // 循环终点（秒）
    let loopActive = false; // 循环引擎是否运转中
    let loopVideo = null;   // 打点锚定的那个 video 元素，换页即失效
    let seamPending = false; // 已经安排好“淡出 → 跳回 A”，等待执行中

    const LOOP_FADE_S = 0.03;      // fade length at the loop seam
    const LOOP_LOOKAHEAD_S = 0.35; // must exceed the 200 ms poll interval, so the seam is scheduled before B

    function fmtTime(t) {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function getMainVideo() {
        return document.querySelector('video');
    }

    function loopLengthOk() {
        return loopA !== null && loopB !== null && loopB - loopA >= 0.3;
    }

    function updateLoopUI() {
        btnA.style.background = loopA !== null ? '#fb7299' : '#fff';
        btnA.style.color = loopA !== null ? '#fff' : '#fb7299';
        btnB.style.background = loopB !== null ? '#fb7299' : '#fff';
        btnB.style.color = loopB !== null ? '#fff' : '#fb7299';
        // The status line is clickable whenever there is a valid A-B range: start / stop the loop
        abStatus.style.cursor = loopLengthOk() ? 'pointer' : 'default';
        abStatus.title = loopActive ? '点击停止循环（A/B 点保留）' : (loopLengthOk() ? '点击开始循环' : '');

        if (loopActive) {
            abStatus.innerText = '↻ ' + fmtTime(loopA) + '~' + fmtTime(loopB);
            abStatus.style.color = '#fb7299';
            abStatus.style.fontWeight = 'bold';
        } else {
            abStatus.style.fontWeight = 'normal';
            if (loopLengthOk()) {
                abStatus.innerText = '▶ ' + fmtTime(loopA) + '~' + fmtTime(loopB);
                abStatus.style.color = '#fb7299';
            } else if (loopA !== null && loopB !== null) {
                abStatus.innerText = fmtTime(loopA) + '~' + fmtTime(loopB) + ' 太短';
                abStatus.style.color = '#e67e22';
            } else if (loopA !== null) {
                abStatus.innerText = 'A ' + fmtTime(loopA) + ' ~ …';
                abStatus.style.color = '#999';
            } else if (loopB !== null) {
                abStatus.innerText = '… ~ B ' + fmtTime(loopB);
                abStatus.style.color = '#999';
            } else {
                abStatus.innerText = 'A-B 关';
                abStatus.style.color = '#999';
            }
        }
    }

    function restoreLoopFade() {
        if (loopFadeGain) rampParam(loopFadeGain.gain, 1, 0, LOOP_FADE_S);
    }

    // Seek to A while muted by the loop fade, fade back in once the seek has completed
    function jumpToA(video) {
        if (loopFadeGain) {
            rampParam(loopFadeGain.gain, 0, 0, 0.005);
            video.addEventListener('seeked', restoreLoopFade, { once: true });
        }
        video.currentTime = loopA;
    }

    // 循环引擎：每次检查当前播放位置，越过 B 或溜回 A 之前就拽回 A
    function loopCheck() {
        if (!loopActive) return;
        const video = getMainVideo();
        if (!video || video !== loopVideo) {
            console.log('[Apeiria] 检测到视频元素更换，A-B循环自动解除！');
            clearLoop();
            return;
        }
        if (seamPending) return;
        // 0.3 秒容差：防止刚 seek 到 A 的瞬间因微小回抖被反复触发
        if (video.currentTime >= loopB || video.currentTime < loopA - 0.3) {
            jumpToA(video);
            return;
        }
        // 快到 B 时：在音频时钟上提前安排淡出，淡出结束的瞬间再跳回 A，接缝处不会“咔”一下
        const remaining = (loopB - video.currentTime) / video.playbackRate;
        if (!video.paused && remaining < LOOP_LOOKAHEAD_S) {
            seamPending = true;
            if (loopFadeGain) {
                rampParam(loopFadeGain.gain, 0, Math.max(0, remaining - LOOP_FADE_S), LOOP_FADE_S);
            }
            setTimeout(() => {
                seamPending = false;
                if (!loopActive || getMainVideo() !== loopVideo || loopVideo.paused) {
                    // loop cleared / video replaced / user paused meanwhile: undo the fade, loopCheck takes over
                    restoreLoopFade();
                    return;
                }
                jumpToA(loopVideo);
            }, remaining * 1000);
        }
    }

    function maybeStartLoop() {
        if (loopA === null || loopB === null) return;
        if (loopB - loopA < 0.3) {
            console.warn('[Apeiria] B 必须比 A 晚至少 0.3 秒，循环未启动！');
            updateLoopUI();
            return;
        }
        const video = getMainVideo();
        if (!video) return;
        loopVideo = video;
        if (!loopActive) {
            loopActive = true;
            console.log('[Apeiria] A-B循环引擎点火！' + fmtTime(loopA) + ' ~ ' + fmtTime(loopB));
        }
        // 按页面记住 A-B 点，下次打开同一个视频（同一个分P）时恢复（不自动开始）
        const loops = loadMap(STORE_LOOPS);
        loops[getPageKey()] = { a: loopA, b: loopB };
        saveMap(STORE_LOOPS, loops);
        // 激活时如果播放头不在区间内，立刻拽回 A 让用户马上听到循环
        if (video.currentTime < loopA || video.currentTime >= loopB) {
            jumpToA(video);
        }
        updateLoopUI();
    }

    // Clears the loop in memory only; the saved A-B points are removed by the ✕ button
    function clearLoop() {
        loopA = null;
        loopB = null;
        stopLoop();
    }

    // Stops looping but keeps the A-B points (and the saved record)
    function stopLoop() {
        loopActive = false;
        loopVideo = null;
        restoreLoopFade();
        updateLoopUI();
    }

    btnA.onclick = () => {
        const video = getMainVideo();
        if (!video) {
            console.warn('[Apeiria] 找不到视频元素，A 点设置失败！');
            return;
        }
        loopA = video.currentTime;
        if (loopB !== null && loopB <= loopA) loopB = null; // 区间被改坏，B 作废重设
        console.log('[Apeiria] A 点已锚定在 ' + fmtTime(loopA));
        updateLoopUI();
        maybeStartLoop();
    };

    btnB.onclick = () => {
        const video = getMainVideo();
        if (!video) {
            console.warn('[Apeiria] 找不到视频元素，B 点设置失败！');
            return;
        }
        loopB = video.currentTime;
        if (loopA !== null && loopB <= loopA) loopA = null; // 区间被改坏，A 作废重设
        console.log('[Apeiria] B 点已锚定在 ' + fmtTime(loopB));
        updateLoopUI();
        maybeStartLoop();
    };

    btnClear.onclick = () => {
        clearLoop();
        const loops = loadMap(STORE_LOOPS);
        delete loops[getPageKey()];
        saveMap(STORE_LOOPS, loops);
        console.log('[Apeiria] A-B循环已清除（记录也已删除），自由播放恢复！');
    };

    abStatus.onclick = () => {
        if (loopActive) {
            stopLoop();
            console.log('[Apeiria] A-B循环已暂停，A/B 点保留，再点一下状态行继续～');
        } else if (loopLengthOk()) {
            maybeStartLoop();
        }
    };

    // timeupdate 是视频播放时浏览器周期触发的时间更新事件（约每秒4次），
    // 在 document 上用捕获监听可以兜住任意（包括事后替换的）video 元素；
    // 后台标签页里 requestAnimationFrame 会被冻结，所以用它做主驱动，另加 200ms 轮询兜底。
    document.addEventListener('timeupdate', loopCheck, { capture: true });
    setInterval(loopCheck, 200);

    // 3.5 换页检测：恢复本页记住的 A-B 点（只恢复，不自动开始），切换到本页 UP 主的音量
    let currentPageKey = null;
    let currentUpMid = null;       // uploader id of the current video, null on bangumi / unknown

    // One key per video part: bangumi pages are keyed by their ep path, normal videos by BV path + ?p=
    function getPageKey() {
        const p = new URLSearchParams(location.search).get('p') || '1';
        return location.pathname.replace(/\/$/, '') + '?p=' + p;
    }

    function getBvid() {
        const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
        return m ? m[1] : null;
    }

    function loadUpVolume() {
        currentUpMid = null;
        const bvid = getBvid();
        if (!bvid) return; // bangumi / av-number pages: only the global volume applies
        fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' })
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(j => {
                if (j.code !== 0) throw new Error('API code ' + j.code + ': ' + j.message);
                if (getBvid() !== bvid) return; // user already navigated away
                currentUpMid = String(j.data.owner.mid);
                const saved = loadMap(STORE_UP_VOLUME)[currentUpMid];
                if (saved !== undefined) {
                    setVolumeDb(saved);
                    console.log('[Apeiria] 已切换到 UP 主「' + j.data.owner.name + '」记住的音量 ' + saved + ' dB');
                }
            })
            .catch(e => console.error('[Apeiria] 读取 UP 主信息失败（' + bvid + '），本页只使用全局音量：', e));
    }

    function checkPageChange() {
        const key = getPageKey();
        if (key === currentPageKey) return;
        const isInitial = currentPageKey === null;
        currentPageKey = key;
        if (!isInitial) {
            console.log('[Apeiria] 检测到换页：' + key);
            clearLoop();
        }
        const saved = loadMap(STORE_LOOPS)[key];
        if (saved) {
            loopA = saved.a;
            loopB = saved.b;
            console.log('[Apeiria] 找到本视频记住的 A-B 点 ' + fmtTime(loopA) + ' ~ ' + fmtTime(loopB) + '，点状态行开始循环～');
            updateLoopUI();
        }
        loadUpVolume();
    }

    // 4. 音量核心魔法：接管并重构前向传播图
    function hookAudio() {
        const video = document.querySelector('video');
        if (video && !video.dataset.apeiriaHooked) {
            try {
                if (!globalAudioCtx) {
                    globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    buildAudioGraph(globalAudioCtx);
                }
                const source = globalAudioCtx.createMediaElementSource(video);
                source.connect(globalGainNode);

                video.dataset.apeiriaHooked = "true";
                console.log("[Apeiria] 叮咚！成功接管音频张量！✨");
            } catch (e) {
                console.warn("[Apeiria] 挂载节点时遇到阻力...", e);
            }
        }
    }

    // 5. 全局唤醒魔法 (解决无声Bug的核心！)
    function tryResumeContext() {
        if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
            globalAudioCtx.resume().then(() => {
                console.log("[Apeiria] 哔哔！检测到页面交互，音频计算图已全线贯通！Boom！");
            });
        }
    }

    // 在文档根节点埋下监听器，捕获任何点击或按键信号作为激活条件
    document.addEventListener('click', tryResumeContext, { capture: true });
    document.addEventListener('keydown', tryResumeContext, { capture: true });

    // 6. 音量 UI 交互事件
    let isCollapsed = false;

    toggleBtn.onclick = () => {
        isCollapsed = !isCollapsed;
        sliderWrapper.style.height = isCollapsed ? '0px' : '196px';
        hookAudio();
    };

    function setVolumeDb(db) {
        slider.value = String(db);
        currentVolume = dbToGain(db);
        updateVolumeLabel(db);
        if (globalGainNode) {
            // Smooth ramp (30 ms time constant) instead of a step change, avoids clicks while dragging
            globalGainNode.gain.setTargetAtTime(currentVolume, globalAudioCtx.currentTime, 0.03);
        }
        applyLimiterBypass(false);
    }

    slider.oninput = (e) => {
        const db = parseFloat(e.target.value);
        setVolumeDb(db);
        // 记住音量：全局一份，当前 UP 主一份
        localStorage.setItem(STORE_VOLUME, String(db));
        if (currentUpMid !== null) {
            const upVolumes = loadMap(STORE_UP_VOLUME);
            upVolumes[currentUpMid] = db;
            saveMap(STORE_UP_VOLUME, upVolumes);
        }
        hookAudio();
    };

    // Limiter indicator: DynamicsCompressorNode.reduction is the current gain reduction in dB (≤ 0).
    // Chrome's meter starts at a large negative value even on silence and decays over ~1 s (measured),
    // so readings from the first 2 s after creation are ignored.
    function updateLimiterLabel() {
        if (isLimiterBypassed()) {
            limiterLabel.innerText = '限幅 关';
            limiterLabel.style.color = '#bbb';
            return;
        }
        const ready = globalCompressor && performance.now() - compressorCreatedAt > 2000;
        const r = ready ? globalCompressor.reduction : 0;
        limiterLabel.innerText = '限幅 ' + (r > -0.05 ? '0.0' : r.toFixed(1)) + ' dB';
        limiterLabel.style.color = r < -1 ? '#e67e22' : '#bbb';
    }
    setInterval(updateLimiterLabel, 250);

    // 6.5 声道控制（默认关闭，每次打开页面都从关闭状态开始）
    let monoOn = false;
    let balance = 0; // -1 = left only … +1 = right only

    function applyChannelSettings(immediate) {
        if (!channelMatrix) return;
        // Balance only attenuates the opposite side, never boosts
        const gL = balance > 0 ? 1 - balance : 1;
        const gR = balance < 0 ? 1 + balance : 1;
        const self = monoOn ? 0.5 : 1;
        const cross = monoOn ? 0.5 : 0;
        const targets = { LL: self * gL, RL: cross * gL, LR: cross * gR, RR: self * gR };
        for (const name in targets) {
            const param = channelMatrix[name].gain;
            if (immediate) param.value = targets[name];
            else param.setTargetAtTime(targets[name], globalAudioCtx.currentTime, 0.02);
        }
    }

    function updateBalanceLabel() {
        const pct = Math.round(Math.abs(balance) * 100);
        balanceLabel.innerText = pct === 0 ? '平衡 居中' : '平衡 偏' + (balance < 0 ? '左 ' : '右 ') + pct;
    }

    function onBalanceChange() {
        balance = parseInt(balanceSlider.value, 10) / 100;
        updateBalanceLabel();
        applyChannelSettings(false);
        hookAudio();
    }

    monoBtn.onclick = () => {
        monoOn = !monoOn;
        setPillActive(monoBtn, monoOn);
        applyChannelSettings(false);
        hookAudio();
    };
    balanceSlider.oninput = onBalanceChange;
    balanceSlider.ondblclick = () => {
        balanceSlider.value = '0';
        onBalanceChange();
    };

    // 6.6 睡眠定时器：到点前 2 分钟开始渐弱，到点暂停视频
    const SLEEP_CHOICES_MIN = [0, 15, 30, 60]; // 0 = off
    const SLEEP_FADE_S = 120;
    let sleepChoice = 0;
    let sleepEndAt = null; // Date.now() timestamp when playback is paused
    let sleepFading = false;

    function restoreSleepGain() {
        sleepFading = false;
        if (sleepGain) rampParam(sleepGain.gain, 1, 0, 0.05);
    }

    function updateSleepUI() {
        const min = SLEEP_CHOICES_MIN[sleepChoice];
        sleepBtn.innerText = min === 0 ? '💤 定时 关' : '💤 定时 ' + min + ' 分';
        setPillActive(sleepBtn, min !== 0);
        if (sleepEndAt === null) {
            sleepBadge.style.display = 'none';
        } else {
            sleepBadge.style.display = 'inline';
            sleepBadge.innerText = '💤' + fmtTime(Math.max(0, (sleepEndAt - Date.now()) / 1000));
        }
    }

    sleepBtn.onclick = () => {
        sleepChoice = (sleepChoice + 1) % SLEEP_CHOICES_MIN.length;
        const min = SLEEP_CHOICES_MIN[sleepChoice];
        restoreSleepGain();
        sleepEndAt = min === 0 ? null : Date.now() + min * 60000;
        console.log(min === 0 ? '[Apeiria] 睡眠定时已关闭' : '[Apeiria] 睡眠定时 ' + min + ' 分钟，晚安～');
        updateSleepUI();
        hookAudio();
    };

    function sleepTick() {
        if (sleepEndAt === null) return;
        const remaining = (sleepEndAt - Date.now()) / 1000;
        if (remaining <= 0) {
            const video = getMainVideo();
            if (video) video.pause();
            console.log('[Apeiria] 睡眠定时到点，视频已暂停。Owner 晚安～');
            sleepEndAt = null;
            sleepChoice = 0;
            // Restore after the pause has taken effect, so the next play starts at normal volume
            setTimeout(restoreSleepGain, 500);
            updateSleepUI();
            return;
        }
        if (remaining <= SLEEP_FADE_S && !sleepFading && sleepGain) {
            sleepFading = true;
            rampParam(sleepGain.gain, 0, 0, remaining);
        }
        updateSleepUI();
    }

    // 7. 定时巡视守护
    setInterval(() => {
        hookAudio();
        // 顺便检查一下是否被意外挂起
        tryResumeContext();
    }, 2000);
    setInterval(() => {
        checkPageChange();
        sleepTick();
    }, 1000);

    const savedDb = localStorage.getItem(STORE_VOLUME);
    setVolumeDb(savedDb === null ? 0 : parseFloat(savedDb));
    updateBalanceLabel();
    updateSleepUI();
    updateLoopUI();
    checkPageChange();
})();
