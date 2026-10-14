import React, { useState, useEffect } from 'react';
import axios from 'axios';
import ConfirmModal from './components/ConfirmModal';
import TagInput from './components/TagInput';

function App() {
    const platformDropdownRef = React.useRef(null);
    const locationDropdownRef = React.useRef(null);

    const [jobs, setJobs] = useState([]);
    const [selectedJob, setSelectedJob] = useState(null); 
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedJobId, setSelectedJobId] = useState(null);
    
    const [deletedJobData, setDeletedJobData] = useState(null);
    const [undoTimer, setUndoTimer] = useState(null);
    const [sortBy, setSortBy] = useState(localStorage.getItem('sortBy') || 'date-asc');
    const [searchTerm, setSearchTerm] = useState(localStorage.getItem('searchTerm') || '');
    const [isScanning, setIsScanning] = useState(false);
    const [scanMessage, setScanMessage] = useState('');

    const [groupByCompany, setGroupByCompany] = useState(() => {
        const saved = localStorage.getItem('groupByCompany');
        return saved !== null ? JSON.parse(saved) : false;
    });

    const [collapsedCompanies, setCollapsedCompanies] = useState({});
    
    const toggleCompanyCollapse = (companyName) => {
        setCollapsedCompanies((prev) => ({
            ...prev,
            [companyName]: !prev[companyName],
        }));
    }

    // Switchable mode: 'any' (matches at least one) or 'all' (must match every keyword)
    const [keywordMatchMode, setKeywordMatchMode] = useState(localStorage.getItem('keywordMatchMode') || 'any');
    const [statusFilter, setStatusFilter] = useState(localStorage.getItem('statusFilter') || 'not_applied');
    const [remoteFilter, setRemoteFilter] = useState(localStorage.getItem('remoteFilter') || 'all');
    const [usEligibleFilter, setUsEligibleFilter] = useState(localStorage.getItem('usEligibleFilter') || 'all');


    // General keywords list
    const [generalKeywords, setGeneralKeywords] = useState(() => {
        try{
            return JSON.parse( localStorage.getItem('generalKeywords')  ) || [];

        } catch {
            return [];
        }
    });

    // Exclude keyword tags list
    const [removeKeywords, setRemoveKeywords] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('removeKeywords')) || [];
        } catch {
            return [];
        }
    });





    // Extract unique platform options dynamically
    const uniquePlatforms = React.useMemo(() => {
        return [...new Set(jobs.map(job => job.platform).filter(Boolean))].sort();
    }, [jobs]);

    const [isPlatformDropdownOpen, setIsPlatformDropdownOpen] = useState(false);

    // Initialize state to show all by default if nothing is stored in localStorage
    const [platformFilter, setPlatformFilter] = useState(() => {
        const saved = localStorage.getItem('platformFilter');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return [];
            }
        }
        // Default to all unique platforms so everything shows by default
        return uniquePlatforms;
    });

    useEffect(() => {
        localStorage.setItem('platformFilter', JSON.stringify(platformFilter));
    }, [platformFilter]);





    const [isLocationDropdownOpen, setIsLocationDropdownOpen] = useState(false);
        
    // Extract unique location options dynamically
    const uniqueLocations = React.useMemo(() => {
        return [...new Set(jobs.map(job => job.location).filter(Boolean))].sort();
    }, [jobs]);

    // Initialize location filter state (default to all unique locations)
    const [locationFilter, setLocationFilter] = useState(() => {
        const saved = localStorage.getItem('locationFilter');
        if (saved) {
            try { return JSON.parse(saved); } catch (e) { return []; }
        }
        return uniqueLocations;
    });

    // Save to localStorage whenever it changes
    useEffect(() => {
        localStorage.setItem('locationFilter', JSON.stringify(locationFilter));
    }, [locationFilter]);


    const getDateGradationColor = (dateString) => {
        if (!dateString) return 'transparent';
        
        const jobDate = new Date(dateString);
        const currentDate = new Date();
        
        // Reset hours to compare pure calendar days/weeks
        jobDate.setHours(0, 0, 0, 0);
        currentDate.setHours(0, 0, 0, 0);
        
        // Calculate difference in weeks
        const diffTime = currentDate - jobDate;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        const diffWeeks = Math.floor(diffDays / 7);

        if (diffWeeks <= 0) {
            return '#0066cc'; // Current week: Blue
        } else if (diffWeeks === 1) {
            return '#3399ff'; // 1 week ago: Lighter Blue
        } else if (diffWeeks === 2) {
            return '#ffcc00'; // 2 weeks ago: Yellow
        } else if (diffWeeks === 3) {
            return '#ff9933'; // 3 weeks ago: Orange-Yellow
        } else {
            return '#cc0000'; // 4+ weeks (older): Red
        }
    };


    // 📜 Job status data structure
    const jobStatuses = [
        { value: "all", label: "All" },
        { value: "applied", label: "Applied" },
        { value: "not_applied", label: "Not Applied" }
    ];

    const handleReset = () => {
        setSearchTerm('');
        localStorage.removeItem('searchTerm');

        setRemoteFilter('all');
        localStorage.removeItem('remoteFilter');

        setSortBy( 'date-asc'); // Reset sortBy to 'all'
        localStorage.removeItem('sortBy');

        // Reset platform filter back to all unique platforms
        setPlatformFilter(uniquePlatforms);
        localStorage.removeItem('platformFilter');

        setLocationFilter(uniqueLocations);
        localStorage.removeItem('locationFilter');

        setUsEligibleFilter('all');
        localStorage.removeItem('usEligibleFilter');

        setStatusFilter('all');
        localStorage.removeItem('statusFilter');

        setGeneralKeywords([]);
        localStorage.removeItem('generalKeywords');

        setRemoveKeywords([]);
        localStorage.removeItem('removeKeywords');

        setKeywordMatchMode('any');
        localStorage.removeItem('keywordMatchMode');
    };


    const filteredAndSortedJobs = React.useMemo(() => {
        return [...jobs]
            .filter((job) => {
                const matchesSearch = 
                    (job.title && job.title.toLowerCase().includes(searchTerm.toLowerCase())) ||
                    (job.company && job.company.toLowerCase().includes(searchTerm.toLowerCase())) ||
                    (job.platform && job.platform.toLowerCase().includes(searchTerm.toLowerCase())) ||
                    (job.location && job.location.toLowerCase().includes(searchTerm.toLowerCase()));

                const matchesLocationFilter = 
                    locationFilter.length === 0 || 
                    locationFilter.includes(job.location);

                const matchesUsEligible =
                    usEligibleFilter === 'all' ||
                    (usEligibleFilter === 'yes' && job.us_eligible) ||
                    (usEligibleFilter === 'no' && !job.us_eligible);

                const matchPlatformFilter = 
                    platformFilter.length === 0 || 
                    platformFilter.includes(job.platform);
                
                const matchStatusFilter =
                    statusFilter === "all" || 
                    (statusFilter === "applied" && job.status === "Applied") || 
                    (statusFilter === "not_applied" && job.status !== "Applied");
                
                const matchesRemoveKeywords = removeKeywords.every((kw) => {
                    const lowerKw = kw.toLowerCase();
                    const containsKeyword = 
                        job.title?.toLowerCase().includes(lowerKw) ||
                        job.company?.toLowerCase().includes(lowerKw) ||
                        job.platform?.toLowerCase().includes(lowerKw);
                    return !containsKeyword;
                });

                const matchesGeneralKeywords = generalKeywords.length === 0 || (
                    keywordMatchMode === 'any' 
                        ? generalKeywords.some((kw) => {
                            const lowerKw = kw.toLowerCase();
                            return job.title?.toLowerCase().includes(lowerKw) || job.company?.toLowerCase().includes(lowerKw) || job.platform?.toLowerCase().includes(lowerKw);
                        })
                        : generalKeywords.every((kw) => {
                            const lowerKw = kw.toLowerCase();
                            return job.title?.toLowerCase().includes(lowerKw) || job.company?.toLowerCase().includes(lowerKw) || job.platform?.toLowerCase().includes(lowerKw);
                        })
                );

                return matchesSearch && matchesLocationFilter && matchPlatformFilter && matchesUsEligible && matchStatusFilter && matchesRemoveKeywords && matchesGeneralKeywords;
            })
            .sort((a, b) => {
                switch (sortBy) {
                    case 'date-desc':
                        return new Date(b.date || 0) - new Date(a.date || 0);
                    case 'date-asc':
                        return new Date(a.date || 0) - new Date(b.date || 0);
                    case 'company-asc':
                        return (a.company || '').localeCompare(b.company || '');
                    case 'company-desc':
                        return (b.company || '').localeCompare(a.company || '');
                    case 'platform-asc':
                        return (a.platform || '').localeCompare(b.platform || '');
                    case 'platform-desc':
                        return (b.platform || '').localeCompare(a.platform || '');
                    case 'status':
                        return (a.status || '').localeCompare(b.status || '');
                    default:
                        return 0;
                }
            });
    }, [jobs, searchTerm, locationFilter, usEligibleFilter, platformFilter, statusFilter, removeKeywords, generalKeywords, keywordMatchMode, sortBy]);

    // Group jobs by company if the toggle is active
    const groupedJobs = groupByCompany 
    ? Object.groupBy(filteredAndSortedJobs, job => job.company || 'Unknown Company')
    : null;



    const fetchJobs = async () => {
        axios.get('http://localhost:5000/api/jobs')
            .then((response) => {
                setJobs(response.data);

                if( response.data.length > 0 && !selectedJob){
                    setSelectedJob(response.data[0]);
                }

                setLoading(false);
            })
            .catch((err) => {
                console.log(' Error fetching data:', err);
                setError('Failed to fetch data.');
                setLoading(false);
        });
    };



    const getMsgIdColor = (msgId) => {
        if(!msgId) return '#f0f0f0';
            let hash = 0;
        for(let i = 0; i < msgId.length; i++) {
            hash += msgId.charCodeAt(i) + ((hash << 5) - hash );
        }

        const hue = Math.abs( hash) % 360;

        return `hsl(${hue}, 70%, 85%)`;
    };


    const getPlatformColor = (platform) => {
        if (!platform) return '#333';
        const p = platform.toLowerCase();

        if (p.includes('linkedin')) return '#0a66c2';        // LinkedIn Blue
        if (p.includes('indeed')) return '#003a9b';          // Indeed Dark Blue
        if (p.includes('glassdoor')) return '#0caa41';       // Glassdoor Green
        if (p.includes('handshake')) return 'rgb(255, 230, 9)';       // 
        if (p.includes('google') || p.includes('job alerts from google')) return '#ea4335'; // Google Red

        return '#555'; // Default fallback color
    };


    // 1. Open modal when user clicks delete icon on a job card
    const handleOpenDeleteModal = (jobId) => {
        setSelectedJobId(jobId);
        setIsModalOpen(true);
    };


    // 2. Execute deletion when confirmed inside modal
    const handleConfirmDelete = async () => {
        if (!selectedJobId) return;

        try {
        // API call to Express backend
        await axios.delete(`http://localhost:5000/api/jobs/${selectedJobId}`);

        // Update state to remove deleted job instantly
        setJobs((prevJobs) => prevJobs.filter((job) => job._id !== selectedJobId));

        // Close modal reset state
        setIsModalOpen(false);
        setSelectedJobId(null);
        } catch (error) {
        console.error('Error deleting job listing:', error);
        }
    };


    const handleRunEmailScan = async () => {
        setIsScanning(true);
        setScanMessage('Scanning emails...');

        try{
            const response = await axios.post('http://localhost:5000/api/jobs/emailScan', {
                dryRun: false,
                noEnrich: false,
            });

            setScanMessage(response.data.message || 'Scanning emails in background');

            const pollInterval = setInterval( async () => {
                try{
                    const statusRes = await axios.get('http://localhost:5000/api/jobs/emailScan/status');

                    if( !statusRes.data.isScanning ){
                        clearInterval( pollInterval );

                        fetchJobs();
                        setIsScanning(false);

                        const durationMsg = statusRes.data.duration 
                            ? `Email scan complete (${statusRes.data.duration}s)` 
                            : 'Email scan complete!';

                        setScanMessage(durationMsg);

                        // Auto-hide success message after 6 seconds
                        setTimeout(() => {
                            setScanMessage('');
                        }, 6000);
                    }

                } catch( pollErr ){
                    console.error("Error checking scan status", pollErr);
                }
            }, 5000);


        } catch(error){
            console.error('Error scanning emails:', error);
            setScanMessage('Error scanning emails');
            setIsScanning(false);
        }
    };



    // Directly execute deletion without opening the confirm modal
    // const handleDeleteJob = async (jobId) => {
    //   if (!jobId) return;

    //   try {
    //     // API call to Express backend
    //     await axios.delete(`http://localhost:5000/api/jobs/${jobId}`);

    //     // Update state to remove deleted job instantly
    //     setJobs((prevJobs) => {
    //       const updatedJobs = prevJobs.filter((job) => job._id !== jobId);
            
    //       // If the currently selected job is the one being deleted, clear or shift selection
    //       if (selectedJob && selectedJob._id === jobId) {
    //         setSelectedJob(updatedJobs.length > 0 ? updatedJobs[0] : null);
    //       }

    //       return updatedJobs;
    //     });
    //   } catch (error) {
    //     console.error('Error deleting job listing:', error);
    //   }
    // };


    const handleDeleteJob = async (jobId) => {
        if (!jobId) return;

        // Find the job object before removing it locally so we can restore it if "Undo" is clicked
        const jobToDelete = jobs.find((j) => j._id === jobId);

        // Clear any existing active undo timer
        if (undoTimer) {
            clearTimeout(undoTimer);
        }

        try {
            // Perform soft delete request
            await axios.delete(`http://localhost:5000/api/jobs/${jobId}`);

            // Update local state to remove it visually
            setJobs((prevJobs) => {
                const updatedJobs = prevJobs.filter((job) => job._id !== jobId);
                if (selectedJob && selectedJob._id === jobId) {
                    setSelectedJob(updatedJobs.length > 0 ? updatedJobs[0] : null);
                }
                return updatedJobs;
            });

            // Hold onto the deleted job for the undo window
            setDeletedJobData(jobToDelete);

            // Set a 60-second timeout to clear the undo option
            const timer = setTimeout(() => {
                setDeletedJobData(null);
                setUndoTimer(null);
            }, 60000);

            setUndoTimer(timer);
        } catch (error) {
            console.error("Error deleting job listing:", error);
        }
    };

    const handlePatchJob = async (jobId, updatedFields) => {
    if (!jobId) return;

    try {
        // Send PATCH request instead of PUT
        const response = await axios.patch(`http://localhost:5000/api/jobs/${jobId}`, updatedFields);
        const updatedJobFromServer = response.data.job;

        // Update the local jobs state
        setJobs((prevJobs) =>
        prevJobs.map((job) => (job._id === jobId ? updatedJobFromServer : job))
        );

        // Update selected job if it matches
        if (selectedJob && selectedJob._id === jobId) {
        setSelectedJob(updatedJobFromServer);
        }
    } catch (error) {
        console.error('Error patching job listing:', error);
    }
    };

    // Add the handleUndo function
    const handleUndoDelete = async () => {
        if (!deletedJobData) return;

        if (undoTimer) {
            clearTimeout(undoTimer);
            setUndoTimer(null);
        }

        try {
            await axios.post(`http://localhost:5000/api/jobs/${deletedJobData._id}/undo`);

            // Put the job back into the list
            setJobs((prevJobs) => [deletedJobData, ...prevJobs]);
            setSelectedJob(deletedJobData);
            setDeletedJobData(null);
        } catch (error) {
            console.error('Error undoing deletion:', error);
        }
    };



    useEffect(() => {
        const handleClickOutside = (event) => {
            if (platformDropdownRef.current && !platformDropdownRef.current.contains(event.target)) {
                setIsPlatformDropdownOpen(false);
            }

            if (locationDropdownRef.current && !locationDropdownRef.current.contains(event.target)) {
                setIsLocationDropdownOpen(false);
            }

        };

        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };

    }, []);





    useEffect(() => {
        localStorage.setItem('groupByCompany', JSON.stringify(groupByCompany));
    }, [groupByCompany]);


    useEffect(() => {
        localStorage.setItem('generalKeywords', JSON.stringify(generalKeywords));
    }, [generalKeywords]);

    useEffect(() => {
        localStorage.setItem('removeKeywords', JSON.stringify(removeKeywords));
    }, [removeKeywords]);

    useEffect(() => {
        localStorage.setItem('keywordMatchMode', keywordMatchMode);
    }, [keywordMatchMode]);



    useEffect(() => {
        localStorage.setItem('searchTerm', searchTerm);
    }, [searchTerm]);

    useEffect(() => {
        localStorage.setItem('remoteFilter', remoteFilter);
    }, [remoteFilter]);

    useEffect(() => {
        localStorage.setItem('sortBy', sortBy);
    }, [sortBy]);



    useEffect(() => {
        localStorage.setItem('usEligibleFilter', usEligibleFilter);
    }, [usEligibleFilter]);

    useEffect(() => {
        localStorage.setItem('statusFilter', statusFilter);
    }, [statusFilter]);

    useEffect(() => {
    // 1. Fetch data from our Node/Express API
    // axios.get('http://localhost:5000/api/jobs')
    //   .then((response) => {
    //     setJobs(response.data);
        
    //     // Automatically select the first job if available
    //     if (response.data.length > 0) {
    //       setSelectedJob(response.data[0]);          
    //     }
        
    //     setLoading(false);
    //   })
    //   .catch((err) => {
    //     console.error('Error fetching jobs:', err);
    //     setError('Failed to load job listings.');
    //     setLoading(false);
    //   });
        fetchJobs();
  }, []);





  if (loading) return <div className="p-8" >🔄 Loading job listings...</div>;
  if (error) return <div className="p-8 text-red-800">❌ {error}</div>;



  return (    
    // <div className="flex min-h-screen font-sans w-full overflow-x-hidden m-0 p-0">
    // <div className="fixed inset-0 w-screen h-screen flex font-sans overflow-hidden m-0 p-0">
    // <div className="fixed inset-0 flex font-sans overflow-hidden overflow-x-hidden m-0 p-0">
    <div className="fixed inset-0 flex font-sans overflow-hidden overflow-x-hidden m-0 p-0">
        

      {/* 👈 Left Sidebar (1/3 Width) */}
       {/* <div className="w-[450px] shrink-0 flex-1 border-r border-gray-200 bg-gray-50 overflow-y-auto max-h-screen relative"> */}
       <div className="w-[350px] shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto max-h-screen relative flex flex-col">

       {/* 📌 Sticky Header Container */}
        <div className="flex flex-col gap-2 top-0 p-4 sticky bg-white z-10 shadow-md border-b border-gray-200">
        
        
        <h2 
            style={{ color: '#111827' }}
            className="text-[#111] font-bold text-[14px] m-0 mb-2">
            💼 Job Listings ({filteredAndSortedJobs.length}/{jobs.length})
        </h2>

        <div>
            {/* 🎛️ Grouping Toggle Option */}
            <div className="flex items-center gap-2 mt-2">
            <label className="text-xs text-gray-700 flex items-center gap-1.5 cursor-pointer">
                <input 
                type="checkbox" 
                checked={groupByCompany} 
                onChange={(e) => setGroupByCompany(e.target.checked)}
                className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
                />
                <span>Group by Company</span>
            </label>
            </div>
        </div>

        {/* 🔍 Search Input */}
        <input 
            type="text"
            placeholder="Search title, company, location..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full box-border outline-none border border-gray-300 rounded px-3 py-1.5 bg-white text-neutral-800 text-xs"
        />

        {/* 🎛️ Filter Controls Row */}
        <div className="flex gap-2">
            {/* Remote Filter */}
            {/* <select 
                value={remoteFilter}
                onChange={(e) => setRemoteFilter(e.target.value)}
                className="flex-1 p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs"
            >
                <option value="all">All Locations</option>
                <option value="remote">Remote Only</option>
                <option value="onsite">On-site / Hybrid</option>

                { uniqueLocations.map((loc) => (
                    <option key={loc} value={loc}>
                        {loc}
                    </option>
                )) }

            </select> */}




        {/* 📍 Location Checkbox Dropdown Container */}
        <div className="relative flex-1" ref={locationDropdownRef}>
            {/* Dropdown Toggle Button */}
            <button
                type="button"
                onClick={() => setIsLocationDropdownOpen(!isLocationDropdownOpen)}
                className="w-full p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs text-left truncate cursor-pointer flex justify-between items-center"
            >
                <span>
                    {locationFilter.length === 0
                        ? "No locations selected" 
                        : locationFilter.length === uniqueLocations.length 
                        ? "All Locations" 
                        : `Locations (${locationFilter.length})`}
                </span>
                <span>▼</span>
            </button>

            {/* Dropdown Checkbox Panel */}
            {isLocationDropdownOpen && (
                <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-300 rounded shadow-lg z-20 p-2 max-h-48 overflow-y-auto text-xs">
                    <div className="flex justify-between pb-1 mb-1 border-b border-gray-200 text-[10px]">
                        <button 
                            type="button"
                            onClick={() => setLocationFilter(uniqueLocations)}
                            className="text-blue-600 hover:underline cursor-pointer bg-transparent border-none"
                        >
                            Select All
                        </button>
                        <button 
                            type="button"
                            onClick={() => setLocationFilter([])}
                            className="text-red-600 hover:underline cursor-pointer bg-transparent border-none"
                        >
                            Clear All
                        </button>
                    </div>

                    {/* 🌟 Static Quick-Filter Options at the Top */}
                    <div className="border-b border-gray-100 pb-1 mb-1">
                        <label className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 cursor-pointer font-medium text-blue-700">
                            <input
                                type="checkbox"
                                checked={locationFilter.length === uniqueLocations.length}
                                onChange={(e) => {
                                    if (e.target.checked) setLocationFilter(uniqueLocations);
                                    else setLocationFilter([]);
                                }}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            />
                            <span>All Locations</span>
                        </label>

                        <label className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={uniqueLocations.filter(loc => loc.toLowerCase().includes('remote')).every(l => locationFilter.includes(l))}
                                onChange={(e) => {
                                    const remoteLocs = uniqueLocations.filter(loc => loc.toLowerCase().includes('remote'));
                                    if (e.target.checked) {
                                        // Add all remote locations without duplicates
                                        setLocationFilter([...new Set([...locationFilter, ...remoteLocs])]);
                                    } else {
                                        // Remove all remote locations
                                        setLocationFilter(locationFilter.filter(l => !l.toLowerCase().includes('remote')));
                                    }
                                }}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            />
                            <span>Remote Only</span>
                        </label>

                        <label className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={uniqueLocations.filter(loc => !loc.toLowerCase().includes('remote')).every(l => locationFilter.includes(l))}
                                onChange={(e) => {
                                    const onsiteLocs = uniqueLocations.filter(loc => !loc.toLowerCase().includes('remote'));
                                    if (e.target.checked) {
                                        setLocationFilter([...new Set([...locationFilter, ...onsiteLocs])]);
                                    } else {
                                        setLocationFilter(locationFilter.filter(l => l.toLowerCase().includes('remote')));
                                    }
                                }}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            />
                            <span>On-site / Hybrid</span>
                        </label>
                    </div>

                    {/* 📋 Dynamic Unique Locations List */}
                    {uniqueLocations.map((loc) => {
                        const isChecked = locationFilter.includes(loc);
                        return (
                            <label key={loc} className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={(e) => {
                                        if (e.target.checked) {
                                            setLocationFilter([...locationFilter, loc]);
                                        } else {
                                            setLocationFilter(locationFilter.filter((l) => l !== loc));
                                        }
                                    }}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                />
                                <span className="truncate text-gray-700">{loc}</span>
                            </label>
                        );
                    })}
                </div>
            )}
        </div>









            

            {/* US Eligible Filter */}
            <select 
            value={usEligibleFilter}
            onChange={(e) => setUsEligibleFilter(e.target.value)}
            className="p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs w-24 min-w-0 truncate"
            >
                <option value="all">US Eligible: All</option>
                <option value="yes">US Eligible: Yes</option>
                <option value="no">US Eligible: No</option>
            </select>

        </div>


        {/* 🎛️ Filter Controls Row */}
        <div className="flex gap-2">
            {/* 🌐 Platform Checkbox Dropdown Container */}
            <div className="relative flex-1" ref={platformDropdownRef}>
                {/* Dropdown Toggle Button */}
                <button
                    type="button"
                    onClick={() => setIsPlatformDropdownOpen(!isPlatformDropdownOpen)}
                    className="w-full p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs text-left truncate cursor-pointer flex justify-between items-center"
                >
                    <span>
                        {platformFilter.length === 0 
                            ? "No platforms selected" 
                            : platformFilter.length === uniquePlatforms.length 
                            ? "All Platforms" 
                            : `Platforms (${platformFilter.length})`}
                    </span>
                    <span>▼</span>
                </button>

                {/* Dropdown Checkbox Panel */}
                {isPlatformDropdownOpen && (
                    <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-300 rounded shadow-lg z-20 p-2 max-h-48 overflow-y-auto text-xs">
                        <div className="flex justify-between pb-1 mb-1 border-b border-gray-200 text-[10px]">
                            <button 
                                type="button"
                                onClick={() => setPlatformFilter(uniquePlatforms)}
                                className="text-blue-600 hover:underline cursor-pointer bg-transparent border-none"
                            >
                                Select All
                            </button>
                            <button 
                                type="button"
                                onClick={() => setPlatformFilter([])}
                                className="text-red-600 hover:underline cursor-pointer bg-transparent border-none"
                            >
                                Clear All
                            </button>
                        </div>

                        {uniquePlatforms.map((plat) => {
                            const isChecked = platformFilter.includes(plat);
                            return (
                                <label key={plat} className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setPlatformFilter([...platformFilter, plat]);
                                            } else {
                                                setPlatformFilter(platformFilter.filter((p) => p !== plat));
                                            }
                                        }}
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    />
                                    <span className="truncate text-gray-700">{plat}</span>
                                </label>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 🌐 Status Dropdown Filter */}
            <select 
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs w-24 min-w-0 truncate"
            >
                <option value="all">All({jobs.length})</option>
                {jobStatuses.map((statusObj) => (
                <option key={statusObj.value} value={statusObj.value}>
                    {statusObj.label}
                </option>
                ))}
            </select>
        </div>


        {/* keyword filtering section in sidebar */}
        <div className="flex flex-col gap-1 my-1">

            {/* General Keywords Filter Block */}
            <div className="flex flex-col gap-0.5 mb-0">
                <div className="flex justify-between items-center">
                    <label className="text-[10px] font-bold text-gray-600">General Keywords:</label>

                    {/* Switcher Toggle (Any vs All) */}
                    <select 
                        value={keywordMatchMode}
                        onChange={(e) => setKeywordMatchMode(e.target.value)}
                        className="text-[10px] border border-gray-300 rounded px-1 py-0.5 bg-white text-gray-700 cursor-pointer"
                    >
                        <option value="any">Match: Any</option>
                        <option value="all">Match: All</option>
                    </select>
                </div>

                <TagInput 
                    tags={generalKeywords}
                    onAddTag={(tag) => setGeneralKeywords((prev) => [...prev, tag])}
                    onRemoveTag={(tag) => setGeneralKeywords((prev) => prev.filter((t) => t !== tag))}
                    placeholder="Include keywords..."
                    accentColor="#0066cc"
                />
            </div>

            {/* 🚫 Remove Keywords Filter Block */}
            <div className="flex flex-col gap-0.5 -mt-[5px]">
                <label className="text-[10px] font-bold text-red-600 text-left">Exclude Keywords (Removes):</label>

                <TagInput 
                    tags={removeKeywords}
                    onAddTag={(tag) => setRemoveKeywords((prev) => [...prev, tag])}
                    onRemoveTag={(tag) => setRemoveKeywords((prev) => prev.filter((t) => t !== tag))}
                    placeholder="Type to exclude..."
                    accentColor="#dc2626" 
                />
            </div>
        </div>





        {/* Floating Sort Controls */}
        <div className="flex items-center gap-4 text-xs pb-1">
            <label htmlFor="sort-select" className="font-bold text-gray-600">
                Sort by:
            </label>

            <select 
                id="sort-select"
                value={sortBy} 
                onChange={(e) => setSortBy(e.target.value)}
                className="flex-1 py-1 px-2 border rounded border-gray-300 bg-white text-xs text-neutral-800 cursor-pointer"
            >
                <option value="date-desc">Oldest Date</option>
                <option value="date-asc">Newest Date</option>
                <option value="company-asc">Company Name (A-Z)</option>
                <option value="company-desc">Company Name (Z-A)</option>
                <option value="platform-asc">Platform (A-Z)</option>
                <option value="platform-desc">Platform (Z-A)</option>
                <option value="status">Status (A-Z)</option>
            </select>
        </div>

        <div className="self-end">
            <button className="cursor-pointer" onClick={handleReset}>Reset</button>
        </div>

    </div>


    </div>



    {/* // mid bar, listings content */}
    <div className="w-[350px] shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto max-h-screen relative flex flex-col">

    {/* // listings container */}
    <div className="flex flex-col gap-4 p-4">
        {groupByCompany ? (
            // 🏢 RENDER GROUPED VIEW BY COMPANY
            Object.entries(groupedJobs).map(([companyName, companyJobs]) => 
            {
                const isCollapsed = collapsedCompanies[companyName] || false;

                return ( 
                    <div 
                        key={companyName} 
                        onClick={() => toggleCompanyCollapse(companyName)}
                        className="space-y-3"
                    >
                        {/* Company Section Header */}
                        <div className="bg-gray-200 px-3 py-1.5 rounded text-xs font-bold text-gray-700 flex justify-between items-center sticky top-0 z-5">
                            <span>
                                <span>{isCollapsed ? '▶' : '▼'}</span>
                                🏢 {companyName}
                            </span>

                            <span className="bg-white text-gray-600 rounded-full px-2 py-0.5 text-[10px] shadow-sm">
                                {companyJobs.length} {companyJobs.length === 1 ? 'job' : 'jobs'}
                            </span>
                        </div>

                        {/* Jobs belonging to this company */}
                        {!isCollapsed && (
                            <div className="flex flex-col gap-3 pl-2">
                            {companyJobs.map((job) => {
                                const isSelected = selectedJob && selectedJob._id === job._id;

                                return (
                                <div 
                                    key={job._id} 
                                    onClick={() => setSelectedJob(job)}
                                    className={`rounded-lg p-4 cursor-pointer transition-colors duration-200 text-xs text-left shadow-sm ${ isSelected ? 'border-2 border-blue-600 bg-blue-50' : 'border border-gray-200 bg-white hover:border-gray-300'}`}
                                >
                                    {/* Job Card Content Structure */}
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="flex flex-col gap-1 text-[8px] text-gray-400 leading-tight">
                                            <span className="text-[8px]">JobID: {job._id}</span>
                                            <span
                                                className="text-[8px] px-1.5 py-0.5 rounded inline-block w-fit"
                                                style={{ backgroundColor: getMsgIdColor(job.message_id) }}
                                            >
                                                MsgId: {job.message_id || 'N/A'}
                                            </span>
                                        </div>

                                        <div className="flex flex-col items-end gap-2 shrink-0">
                                            <button 
                                                onClick={(e) => { e.stopPropagation(); handleDeleteJob(job._id); }}
                                                className="rounded text-xs bg-transparent cursor-pointer border-none text-gray-400 hover:text-red-600"
                                            >
                                                ❌
                                            </button>

                                            {job.status === 'Applied' ? (
                                                <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                                    Applied ✓
                                                </span>
                                            ) : (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handlePatchJob(job._id, { status: 'Applied' }); }}
                                                    className="rounded text-xs bg-blue-600 text-white border border-emerald-200 px-2 py-0.5 hover:bg-emerald-700 cursor-pointer"
                                                >
                                                    Apply
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="text-center mb-2">
                                        <h3 className="text-base font-semibold text-gray-900 mb-0.5 leading-snug">
                                            {job.title || 'Untitled Role'}
                                        </h3>
                                        
                                        <div 
                                            style={{ 
                                                backgroundColor: getDateGradationColor(job.date || job.last_updated), 
                                                color: '#fff', 
                                                padding: '2px 6px', 
                                                borderRadius: '4px',
                                                display: 'inline-block'
                                            }}
                                            className="text-[10px] font-semibold"
                                        >
                                            {job.last_updated ? `Last Updated: ${new Date(job.last_updated).toLocaleDateString()}` : 'Last Updated: N/A'}
                                        </div>
                                    </div>

                                    <div className="text-gray-600 space-y-1.5">
                                        <div>
                                            <strong>Company:</strong> {job.company || 'N/A'}
                                        </div>

                                        <div>
                                            <strong>Platform:</strong>{' '}
                                            <span 
                                                style={{ backgroundColor: getPlatformColor(job.platform), color:'white' }}
                                                className="font-bold border rounded p-1 m-1"
                                            >
                                            {job.platform || 'N/A'}
                                            </span>
                                        </div>


                                        <div className="flex justify-between gap-2">
                                            <span><strong>Loc:</strong> {job.location || 'N/A'}</span>

                                            <span><strong>Emp Type:</strong> {job.is_staffing_agency ? 'Staffing Agency' : 'Direct Hire'}</span>
                                        </div>


                                        <div className="flex justify-between gap-2">
                                            <span><strong>US Eligible:</strong> {job.us_eligible ? 'Yes' : 'No'}</span>
                                            
                                            <span><strong>Comp:</strong> {job.comp || 'N/A'}</span>
                                        </div>

                                        <div className="text-center pt-1.5 mt-1 border-t border-gray-100">
                                            <strong>Status:</strong> {job.status || 'N/A'}
                                        </div>



                                        <div className="flex justify-center items-center gap-3 mt-4 mb-6">
                                            {/* 📧 View Source Email in Gmail */}
                                            {job.gmail_link && (
                                                <a 
                                                    href={job.gmail_link} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer" 
                                                    style={{ backgroundColor: '#ea4335', color: '#fff' }}
                                                    className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-20"
                                                >
                                                    Gmail
                                                </a>
                                            )}

                                            {/* Embedded URL Section */}
                                            {job.url && (
                                                <a 
                                                    href={job.url} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer" 
                                                    style={{ backgroundColor: '#0066cc', color: '#fff' }}
                                                    className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-20"
                                                >
                                                    New tab
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                );
                            })}
                            </div>
                        )}
                    </div>
                )
            })
        ) : (
            // 📋 RENDER STANDARD FLAT LIST VIEW
            filteredAndSortedJobs.map((job) => {
            const isSelected = selectedJob && selectedJob._id === job._id;
            
            return (
                <div 
                key={job._id} 
                onClick={() => setSelectedJob(job)}
                className={`rounded-lg p-4 cursor-pointer transition-colors duration-200 text-xs text-left shadow-sm ${ isSelected ? 'border-2 border-blue-600 bg-blue-50' : 'border border-gray-200 bg-white hover:border-gray-300'}`}
                >
                {/* Same Job Card Content Structure */}
                <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex flex-col gap-1 text-[8px] text-gray-400 leading-tight">
                        <span className="text-[8px]">JobID: {job._id}</span>
                        <span
                            className="text-[8px] px-1.5 py-0.5 rounded inline-block w-fit"
                            style={{ backgroundColor: getMsgIdColor(job.message_id) }}
                        >
                            MsgId: {job.message_id || 'N/A'}
                        </span>
                    </div>

                    <div className="flex flex-col items-end gap-2 shrink-0">
                        <button 
                            onClick={(e) => { e.stopPropagation(); handleDeleteJob(job._id); }}
                            className="rounded text-xs bg-transparent cursor-pointer border-none text-gray-400 hover:text-red-600"
                        >
                            ❌
                        </button>

                        {job.status === 'Applied' ? (
                            <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                Applied ✓
                            </span>
                        ) : (
                            <button 
                                onClick={(e) => { e.stopPropagation(); handlePatchJob(job._id, { status: 'Applied' }); }}
                                className="rounded text-xs bg-blue-600 text-white border border-emerald-200 px-2 py-0.5 hover:bg-emerald-700 cursor-pointer"
                            >
                                Apply
                            </button>
                        )}
                    </div>
                </div>

                <div className="text-center mb-2">
                    <h3 className="text-base font-semibold text-gray-900 mb-0.5 leading-snug">{job.title || 'Untitled Role'}</h3>
                    <div 
                        style={{ 
                            backgroundColor: getDateGradationColor(job.date || job.last_updated), 
                            color: '#fff', 
                            padding: '2px 6px', 
                            borderRadius: '4px',
                            display: 'inline-block'
                        }}
                        className="text-[10px] font-semibold"
                    >
                        {job.last_updated ? `Last Updated: ${new Date(job.last_updated).toLocaleDateString()}` : 'Last Updated: N/A'}
                    </div>
                </div>

                <div className="text-gray-600 space-y-1.5">
                    <div><strong>Company:</strong> {job.company || 'N/A'}</div>
                    <div>
                        <strong>Platform:</strong>{' '}
                        <span 
                            style={{ backgroundColor: getPlatformColor(job.platform), color:'white' }}
                            className="font-bold border rounded p-1 m-1"
                        >
                        {job.platform || 'N/A'}
                        </span>
                    </div>
                    <div className="flex justify-between gap-2">
                        <span><strong>Loc:</strong> {job.location || 'N/A'}</span>
                        <span><strong>Emp Type:</strong> {job.is_staffing_agency ? 'Staffing Agency' : 'Direct Hire'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                        <span><strong>US Eligible:</strong> {job.us_eligible ? 'Yes' : 'No'}</span>
                        <span><strong>Comp:</strong> {job.comp || 'N/A'}</span>
                    </div>
                    <div className="text-center pt-1.5 mt-1 border-t border-gray-100">
                        <strong>Status:</strong> {job.status || 'N/A'}
                    </div>
                </div>
                </div>
            );
            })
        )}
        </div>

    </div>






      {/* 👉 Main Content Area (2/3 Width) */}
        {/* <div className="flex flex-1 flex-col p-8 overflow-y-auto max-h-screen min-w-0 right-0"> */}
        {/* <div className="flex-1 flex flex-col p-8 overflow-y-auto h-full min-w-0"> */}
        <div className="flex-1 flex flex-col p-8 overflow-y-auto h-full min-w-0 box-border">

        {/* 👉 Tools bar */}
        {/* <div className="flex justify-between items-center w-full mb-4 px-2 py-1 bg-gray-600  border border-gray-300 shadow-md"> */}
        <div className="flex justify-between items-center w-full box-border mb-4 px-2 py-1 bg-gray-600 border border-gray-300 shadow-md">
            <label className="text-white font-bold text-sm "l>Tools: </label>

            <button 
                onClick={ (e)=> { e.stopPropagation(); handleRunEmailScan(); }} 
                className="border rounded cursor-pointer border-gray-300 text-xs p-1 bg-gray-400 text-black ml-2 mr-2 hover:bg-gray-700"
            >
                Scan Emails
            </button>
            
            <button className="border rounded cursor-pointer border-gray-300 text-xs p-1 bg-gray-400 text-black ml-2 mr-2 hover:bg-gray-700">
                Scan Job Listings
            </button>
            
            <button className="border rounded cursor-pointer border-gray-300 text-xs p-1 bg-gray-400 text-black ml-2 mr-2 hover:bg-gray-700">
                Z
            </button>
        </div>


        {selectedJob ? (
          <div className="flex flex-col h-full">
            {/* Listing details */}
            <div style={{ marginBottom: "6px" }}>
                <h1 
                    style = {{ fontSize: '28px', lineHeight: '1.5'  }}
                    className="font-bold  break-words mb-4"
                >
                    {selectedJob.title || 'Untitled Role'}
                </h1>
                    
                <button 
                    onClick={(e) => {e.stopPropagation(); handleDeleteJob(selectedJob._id);}}
                    className="mb-3 cursor-pointer bg-red-50 text-red-700 border border-red-200 rounded px-3 py-1.5 text-sm hover:bg-red-100 mb-2"
                >
                    Delete Job 🗑️
                </button>

                <hr className="border-[0.5px] border-gray-200 my-6" />


                <p className="text-[1.2rem] ">
                    <strong>Company:</strong> {selectedJob.company || 'N/A'}
                </p>

                <p>
                    <strong>Platform:</strong> {selectedJob.platform || 'N/A'}
                </p>

                <p>
                    <strong>Location:</strong> {selectedJob.location || 'N/A'}
                </p>

                <p>
                    <strong>Compensation:</strong> {selectedJob.comp || 'Not specified'}
                </p>

            </div>

            <div className="flex flex-col gap-2.5 mt-4 mb-6 items-center">
                {/* 📧 View Source Email in Gmail */}
                {selectedJob.gmail_link && (
                    <div>
                        <a 
                        href={selectedJob.gmail_link} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        style={{ backgroundColor: '#ea4335', color: '#fff' }}
                        className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-40 mb-2"
                        >
                            Open in Gmail ✉️
                        </a>
                    </div>
                )}

                {/* Embedded URL Section */}
                {selectedJob.url && (
                <div>
                    <a 
                        href={selectedJob.url} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        style={{ backgroundColor: '#0066cc', color: '#fff' }}
                        className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-40 mb-2"
                    >
                        Open in new tab ↗
                    </a>
                </div>
                )}
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                {/* Job Details Section */}
                { !(selectedJob.platform?.toLowerCase() || '').includes('linkedin') ? (
                    <iframe src={`${selectedJob.url}`} className="w-full h-screen block">
                    </iframe>
                ) : null }
            </div>

          </div>
        ) : (
          <p className="text-gray-400">Select a job from the list on the left to view details.</p>
        )}
      </div>

      {/* Confirmation Modal */}
        <ConfirmModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            onConfirm={handleConfirmDelete}
            title="Confirm Deletion"
            message="Are you sure you want to remove this job listing? It will no longer appear in your active list."
        />

      {/* 🪟 Undo Popup Banner */}
      {deletedJobData && (
        <div className="items-center text-white text-sm bg-[#333] fixed flex gap-4 z-[1000] py-3 px-5 rounded-lg left-1/2 -translate-x-1/2 bottom-5 shadow-lg">
          <span>Deleted "{deletedJobData.title}"</span>
          <button 
            onClick={handleUndoDelete}
            className="hover:bg-blue-700 bg-blue-600 text-white rounded cursor-pointer font-bold px-3 py-1.5 border-none"
          >
            Undo
          </button>
        </div>
      )}

      {/* 🪟 Scan Status Banner (Same structure as deleted banner) */}
      {scanMessage && (
        <div className="items-center text-white text-sm bg-[#333] fixed flex gap-4 z-[1000] py-3 px-5 rounded-lg left-1/2 -translate-x-1/2 bottom-5 shadow-lg">
          <span>{scanMessage}</span>
          {/* Optional: Add a close button if it doesn't auto-dismiss */}
          <button 
            onClick={() => setScanMessage('')}
            className="hover:bg-gray-600 bg-gray-700 text-white rounded cursor-pointer font-bold px-2 py-1 border-none text-xs"
          >
            ✕
          </button>
        </div>
      )}

    </div>
  );
}
            
export default App;