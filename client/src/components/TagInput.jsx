import React, { useState } from 'react';

const TagInput = ({ 
    tags = [], 
    onAddTag, 
    onRemoveTag, 
    placeholder='Add keyword...', 
    accentColor = '#0066cc' 
}) => {
    const [inputValue, setInputValue] = useState('');

    const handleKeyDown = (e) => {
        if( e.key === 'Enter' || e.key === ',' ){
            e.preventDefault();

            const trimmed = inputValue.trim();
            const lowerTags = tags.map((t) => t.toLowerCase());

            if (trimmed && !lowerTags.includes(trimmed.toLowerCase())) {
                onAddTag(trimmed);
                setInputValue('');
            }

        }

    };

    return (
        <div className='flex flex-col gap-2'>
            <input 
                type="text"
                value= { inputValue }
                onChange = {(e)=> setInputValue(e.target.value) }
                onKeyDown = {handleKeyDown}
                placeholder= {placeholder}
                className="w-full text-xs p-1.5 border border-gray-300 rounded outline-none"
            ></input>

            <div className="flex flex-wrap gap-1.5">
                { tags.map( ( tag ) => (
                    <span
                        key={tag}
                        style={{ backgroundColor: accentColor }}
                        className="text-white text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1"
                    >
                        {tag}
                        <button
                            type="button"
                            onClick={()=>onRemoveTag(tag)}
                            className="font-bold hover:opacity-75 focus:outline-none"
                        >
                            x
                        </button>
                    </span>
                ))}
            </div>

        </div>
    );
};

export default TagInput;
