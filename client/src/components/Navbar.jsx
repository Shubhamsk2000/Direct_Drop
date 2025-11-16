import { ArrowUpDown } from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'

const Navbar = () => {
    return (
        <header className="px-6 py-4 md:px-8">
            <div className="flex items-center justify-between max-w-5xl mx-auto header-inner">
                <Link to="/" className="flex items-center gap-2">
                    <ArrowUpDown className="w-8 h-8 logo-icon" />
                    <span className="text-xl font-semibold text-primary">Direct Drop</span>
                </Link>
                <div>
                    {location.pathname !== '/' ? (
                        <Link to="/" className="px-3 py-1 text-sm btn-outline">
                            Back to Home
                        </Link>
                    ) : null
                    }
                </div>
            </div>
        </header>
    )
}

export default Navbar