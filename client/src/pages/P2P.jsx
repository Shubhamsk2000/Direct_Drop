import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SendIcon, DownloadIcon } from 'lucide-react';

const P2P = () => {

  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-12 text-center"
      >
        <h1 className="mb-4 text-4xl font-bold md:text-5xl">
          Share files in real-time.
          <span className="block mt-2 text-primary">Simply and securely.</span>
        </h1>
        <p className="max-w-2xl mx-auto text-xl text-muted">
          Connect with a 4-digit code and transfer files directly from one device to another.
          No accounts, no uploads to servers.
        </p>
      </motion.div>

      <div className="grid w-full max-w-4xl grid-cols-1 gap-8 md:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <Link 
            to="/p2p/send" 
            className="flex flex-col items-center justify-center h-full p-10 transition-all border-2 border-transparent card send-card"
          >
            <div className="p-5 mb-6 transition-colors rounded-full icon-wrapper">
              <SendIcon className="w-12 h-12 icon-primary" />
            </div>
            <h2 className="mb-3 text-2xl font-bold">Send Files</h2>
            <p className="text-center text-muted">
              Generate a code and wait for receiver to connect, then send your files.
            </p>
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <Link 
            to="/p2p/receive" 
            className="flex flex-col items-center justify-center h-full p-10 transition-all border-2 border-transparent card receive-card"
          >
            <div className="p-5 mb-6 transition-colors rounded-full icon-wrapper-secondary">
              <DownloadIcon className="w-12 h-12 icon-secondary" />
            </div>
            <h2 className="mb-3 text-2xl font-bold">Receive Files</h2>
            <p className="text-center text-muted">
              Enter the code provided by the sender to connect and receive files.
            </p>
          </Link>
        </motion.div>
      </div>

      <div className="mt-16 text-center">
        <h3 className="mb-4 text-xl font-semibold">How it works</h3>
        <div className="flex flex-col items-start max-w-4xl gap-6 md:flex-row">
          <div className="flex-1 p-6 border border-gray-100 rounded-xl bg-gray-50">
            <div className="mb-2 text-2xl font-bold text-primary-500">01</div>
            <h4 className="mb-2 font-semibold">Generate or Enter Code</h4>
            <p className="text-gray-600">Sender generates a unique 4-digit code, receiver enters it to connect.</p>
          </div>
          <div className="flex-1 p-6 border border-gray-100 rounded-xl bg-gray-50">
            <div className="mb-2 text-2xl font-bold text-primary-500">02</div>
            <h4 className="mb-2 font-semibold">Establish Connection</h4>
            <p className="text-gray-600">A secure peer-to-peer connection is established between devices.</p>
          </div>
          <div className="flex-1 p-6 border border-gray-100 rounded-xl bg-gray-50">
            <div className="mb-2 text-2xl font-bold text-primary-500">03</div>
            <h4 className="mb-2 font-semibold">Transfer Files</h4>
            <p className="text-gray-600">Select and send files directly to the connected device.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default P2P;