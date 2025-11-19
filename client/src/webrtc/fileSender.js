export default async function sendFilesOverDataChannel(channel, files, setProgress, onFileComplete) {
    if (!channel || channel.readyState !== "open") {
        throw new Error("Data channel is not open");
    }

    console.log(`📦 Starting transfer of ${files.length} files`);

    const batchMetadata = {
        type: "batch-metadata",
        totalFiles: files.length,
        files: files.map((file, idx) => ({
            index: idx,
            name: file.name,
            size: file.size,
            type: file.type,
        }))
    };

    channel.send(JSON.stringify(batchMetadata));
    console.log("✅ Batch Metadata sent");
    
    // Add small delay for receiver to process
    await new Promise(resolve => setTimeout(resolve, 100));

    for(let fileIdx = 0; fileIdx < files.length; fileIdx++){
        const file = files[fileIdx];

        channel.send(JSON.stringify({
            type: 'file-start',
            fileIndex: fileIdx,  // ✅ FIXED: was fileIdx
        }));

        console.log(`📄 Starting file ${fileIdx + 1}/${files.length}: ${file.name}`);

        await sendFile(channel, file, (progress) => {
            setProgress(fileIdx, progress);
        });

        channel.send(JSON.stringify({
            type: 'file-complete',
            fileIndex: fileIdx,  // ✅ FIXED: was fileIdx
        }));
        console.log(`✅ File ${fileIdx + 1} complete`);

        if(onFileComplete){
            onFileComplete(fileIdx);
        }
    }

    channel.send(JSON.stringify({
        type: 'transfer-complete'
    }));
    console.log('🎉 All Files sent!');
}

async function sendFile(channel, file, setProgress) {
    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;

    while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        // Better bufferedAmount handling
        while (channel.bufferedAmount > 512 * 1024) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        channel.send(buffer);
        offset += buffer.byteLength;

        if (setProgress) {
            const progress = Math.min(100, (offset / file.size) * 100);
            setProgress(progress);
        }
    }
}
