export function setupDataChannel(pc, onMessage, onOpen) {
    pc.ondatachannel = (event) => {
        const channel = event.channel;

        channel.onopen = () => {
            channel.bufferedAmountLowThreshold = 64 * 1024;
            if (onOpen) onOpen(channel);
        };

        channel.onmessage = (event) => {
            if (onMessage) onMessage(event.data);
        };
    };
}
