export function createFileReceiver(onProgress, onComplete) {
    let metadata = null;
    let received = 0;
    const chunks = [];

    function handleData(data) {

        if (typeof data === "string") {
            try {
                const meta = JSON.parse(data);
                if (meta.type === "metadata") {
                    metadata = meta;
                    return;
                }
            } catch (err) {
                console.log(err.message);
            }
        }

        if (data instanceof ArrayBuffer) {
            chunks.push(data);
            received += data.byteLength;

            if (metadata && onProgress) {
                onProgress((received / metadata.size) * 100);
            }

            if (metadata && received >= metadata.size) {
                const blob = new Blob(chunks, { type: "application/octet-stream" });

                if (onComplete) {
                    onComplete(blob, metadata.name);
                }

                metadata = null;
                received = 0;
                chunks.length = 0;
            }
        }
    }

    return handleData;
}
