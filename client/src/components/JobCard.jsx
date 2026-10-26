import React from 'react';

const JobCard = React.memo(({ 
    job, 
    isSelected, 
    onSelect, 
    onDelete, 
    onApply, 
    getMsgIdColor, 
    getDateGradationColor, 
    getPlatformColor 
}) => {
    return (
        <div 
            onClick={() => onSelect(job)}
            className={`rounded-lg p-4 cursor-pointer transition-colors duration-200 text-xs text-left shadow-sm ${ 
                isSelected ? 'border-2 border-blue-600 bg-blue-50' : 'border border-gray-200 bg-white hover:border-gray-300'
            }`}
        >
            {/* Top row: IDs and Actions */}
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
                        onClick={(e) => { e.stopPropagation(); onDelete(job._id); }}
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
                            onClick={(e) => { e.stopPropagation(); onApply(job._id); }}
                            className="rounded text-xs bg-blue-600 text-white border border-emerald-200 px-2 py-0.5 hover:bg-emerald-700 cursor-pointer"
                        >
                            Apply
                        </button>
                    )}
                </div>
            </div>

            {/* Title and Date Gradation Badge */}
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

            {/* Details Section */}
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

                {/* Quick Link Buttons (Gmail & New Tab) */}
                <div className="flex justify-center items-center gap-3 mt-4 mb-2">
                    {job.gmail_link && (
                        <a 
                            href={job.gmail_link} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            style={{ backgroundColor: '#ea4335', color: '#fff' }}
                            className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-20"
                            onClick={(e) => e.stopPropagation()}
                        >
                            Gmail
                        </a>
                    )}

                    {job.url && (
                        <a 
                            href={job.url} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            style={{ backgroundColor: '#0066cc', color: '#fff' }}
                            className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-20"
                            onClick={(e) => e.stopPropagation()}
                        >
                            New tab
                        </a>
                    )}
                </div>
            </div>
        </div>
    );
});

export default JobCard;