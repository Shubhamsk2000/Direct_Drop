export default function createMultiFileReceiver(onBatchMetadata, onProgress, onFileComplete, onAllComplete) {
    let filesMetadata = [];
    let currentFileIndex = -1;
    let chunks = [];
    let receivedBytes = 0;
    let expectedBytes = 0;

    return function handleData(data) {
        // JSON control messages
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);

                switch (message.type) {
                    case 'batch-metadata':
                        filesMetadata = message.files;
                        console.log('📦 Received batch metadata:', filesMetadata);
                        onBatchMetadata(filesMetadata);
                        break;

                    case 'file-start':
                        currentFileIndex = message.fileIndex;
                        
                        if (!filesMetadata[currentFileIndex]) {
                            console.error(`No metadata for file index ${currentFileIndex}`);
                            return;
                        }
                        
                        const fileInfo = filesMetadata[currentFileIndex];
                        
                        console.log(`📄 Starting file ${currentFileIndex + 1}/${filesMetadata.length}: ${fileInfo.name}`);
                        
                        // Reset buffers for new file
                        chunks = [];
                        receivedBytes = 0;
                        expectedBytes = fileInfo.size;
                        
                        // Set initial progress to 0
                        onProgress(currentFileIndex, 0);
                        break;

                    case 'file-complete':
                        if (currentFileIndex === -1 || !filesMetadata[message.fileIndex]) {
                            console.error(`Invalid file completion for index ${message.fileIndex}`);
                            return;
                        }
                        
                        const completeFileInfo = filesMetadata[message.fileIndex];
                        const blob = new Blob(chunks, { type: completeFileInfo.type });
                        
                        console.log(`✅ File ${message.fileIndex + 1} complete: ${completeFileInfo.name} (${blob.size} bytes)`);
                        
                        // Set progress to 100%
                        onProgress(message.fileIndex, 100);
                        
                        onFileComplete(message.fileIndex, blob, completeFileInfo.name);
                        
                        // Reset for next file
                        chunks = [];
                        receivedBytes = 0;
                        expectedBytes = 0;
                        currentFileIndex = -1;
                        break;

                    case 'transfer-complete':
                        console.log('🎉 All files received!');
                        onAllComplete();
                        break;

                    default:
                        console.warn('Unknown message type:', message.type);
                }
            } catch (e) {
                console.error('Error parsing control message:', e);
            }
        }
        // File chunks (ArrayBuffer)
        else if (data instanceof ArrayBuffer) {
            if (currentFileIndex === -1) {
                console.warn('⚠️ Received chunk but no active file!');
                return;
            }

            chunks.push(data);
            receivedBytes += data.byteLength;

            const progress = expectedBytes > 0 
                ? Math.min(100, (receivedBytes / expectedBytes) * 100)
                : 0;
            
            onProgress(currentFileIndex, progress);

            // Log progress every 25%
            if (progress % 25 < 1) {
                console.log(`File ${currentFileIndex}: ${progress.toFixed(0)}% (${receivedBytes}/${expectedBytes} bytes)`);
            }
        }
        else {
            console.warn('Unknown data type received:', typeof data);
        }
    };
}
