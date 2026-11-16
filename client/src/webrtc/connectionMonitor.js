// Watches an RTCPeerConnection and reports when it can't be established or is lost.

// Give up if the connection isn't up within this long.
export const CONNECT_TIMEOUT_MS = 20_000;
// "disconnected" can recover on its own (e.g. brief Wi-Fi blip); wait this long first.
export const DISCONNECT_GRACE_MS = 5_000;

/**
 * @param {RTCPeerConnection} pc
 * @param {object} opts
 * @param {(message: string) => void} opts.onFailed  called at most once
 * @returns {() => void} stop watching
 */
export function watchPeerConnection(pc, { onFailed, connectTimeoutMs = CONNECT_TIMEOUT_MS, disconnectGraceMs = DISCONNECT_GRACE_MS }) {
    let done = false;
    let everConnected = false;
    let graceTimer = null;

    const clearGrace = () => {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = null;
    };

    const fire = (message) => {
        if (done) return;
        stop();
        onFailed(message);
    };

    const connectTimer = setTimeout(() => {
        if (!everConnected) {
            fire("Couldn't establish a direct connection with the other device (timed out). " +
                "Both devices may be behind strict firewalls or NATs.");
        }
    }, connectTimeoutMs);

    const onChange = () => {
        // Older Firefox lacks connectionState; fall back to the ICE state.
        const ice = pc.iceConnectionState;
        const conn = pc.connectionState;

        if (conn === "failed" || ice === "failed") {
            fire(everConnected
                ? "The connection to the other device failed."
                : "Couldn't establish a direct connection with the other device.");
            return;
        }
        if (conn === "connected" || ice === "connected" || ice === "completed") {
            everConnected = true;
            clearTimeout(connectTimer);
            clearGrace();
            return;
        }
        if ((conn === "disconnected" || ice === "disconnected") && !graceTimer) {
            graceTimer = setTimeout(() => {
                fire("Lost the connection to the other device.");
            }, disconnectGraceMs);
        }
        // "closed" is only reached via pc.close(), i.e. our own teardown.
    };

    pc.addEventListener("connectionstatechange", onChange);
    pc.addEventListener("iceconnectionstatechange", onChange);

    function stop() {
        done = true;
        clearTimeout(connectTimer);
        clearGrace();
        pc.removeEventListener("connectionstatechange", onChange);
        pc.removeEventListener("iceconnectionstatechange", onChange);
    }

    return stop;
}
