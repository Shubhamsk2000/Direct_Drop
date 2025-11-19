export async function sendFileOverDataChannel(channel, file, onProgress) {
    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;

    const metadata = {
        type: "metadata",
        name: file.name,
        size: file.size,
    };

    channel.send(JSON.stringify(metadata));

    while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        while (channel.bufferedAmount > 512 * 1024) {
            await new Promise(resolve => {
                channel.onbufferedamountlow = resolve;
            });
        }

        channel.send(buffer);
        offset += buffer.byteLength;

        if (onProgress) {
            onProgress((offset / file.size) * 100);
        }
    }

    return true;
}
